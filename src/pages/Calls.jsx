import { useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Phone, PhoneCall, PhoneOff, Mic, MicOff, RadioTower, AlertTriangle, Volume2 } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { getTowerForUser } from '../utils/network';

const ACTIVE_CALL_STATUSES = ['pending', 'connecting', 'connected'];
const RING_TIMEOUT_MS = 45000;
const STALE_INCOMING_MS = 90000;
const ICE_GATHER_TIMEOUT_MS = 4000;

// STUN is enough for calls on the same machine / same network. Calls across
// different networks (mobile data, strict NAT) also need a TURN relay, which
// can be configured through VITE_TURN_* env vars (see .env.example).
const TURN_URLS = import.meta.env.VITE_TURN_URLS;
const HAS_TURN = Boolean(TURN_URLS);
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ...(HAS_TURN
    ? [
        {
          urls: TURN_URLS.split(',').map((url) => url.trim()).filter(Boolean),
          username: import.meta.env.VITE_TURN_USERNAME,
          credential: import.meta.env.VITE_TURN_CREDENTIAL,
        },
      ]
    : []),
];

function getErrorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error.name === 'NotAllowedError') return 'Microphone permission was denied. Allow mic access in the browser and try again.';
  if (error.name === 'NotFoundError') return 'No microphone was found on this device.';
  if (error.name === 'NotReadableError') return 'The microphone is in use by another application.';
  return error.message || 'Unknown error';
}

function isMissingCallSchema(message) {
  return message.includes('calls') || message.includes('call_candidates');
}

function formatParticipant(user) {
  const tower = getTowerForUser(user);
  return `${user.username} (${user.phone_number}) • ${tower.name}`;
}

// Non-trickle ICE: wait until candidates are gathered so the full route list
// travels inside the offer/answer SDP stored on the call row.
function waitForIceGathering(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', handleChange);
      resolve();
    };
    const handleChange = () => {
      if (peer.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    peer.addEventListener('icegatheringstatechange', handleChange);
  });
}

async function markCall(callId, fields) {
  const { error } = await supabase.from('calls').update(fields).eq('id', callId);
  if (error) console.error(error);
}

function useAudioLevel(stream) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) return undefined;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return undefined;

    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let frame;

    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }
      const nextLevel = Math.round(Math.min(1, Math.sqrt(sum / samples.length) * 5) * 20) / 20;
      setLevel((previous) => (previous === nextLevel ? previous : nextLevel));
      frame = requestAnimationFrame(tick);
    };

    context.resume().catch(() => {});
    tick();

    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      context.close().catch(() => {});
    };
  }, [stream]);

  return stream ? level : 0;
}

function LevelMeter({ label, level, muted }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-neutral-400">
        <span>{label}</span>
        <span>{muted ? 'muted' : level > 0.05 ? 'signal' : 'silent'}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-75"
          style={{ width: `${muted ? 0 : Math.round(level * 100)}%` }}
        />
      </div>
    </div>
  );
}

export default function Calls() {
  const { currentUser: sessionUser } = useOutletContext() || {};
  const currentUserId = sessionUser?.id ?? null;

  const [users, setUsers] = useState([]);
  const [activeCall, setActiveCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [statusText, setStatusText] = useState('Idle and ready for a voice session.');
  const [connectionState, setConnectionState] = useState('idle');
  const [setupError, setSetupError] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);

  const peerRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const activeCallRef = useRef(null);
  const incomingCallRef = useRef(null);
  const realtimeHandlerRef = useRef(null);

  const localLevel = useAudioLevel(localStream);
  const remoteLevel = useAudioLevel(remoteStream);

  const currentUser = useMemo(() => users.find((user) => user.id === currentUserId) || null, [users, currentUserId]);
  const selectedUser = useMemo(
    () => users.find((user) => String(user.id) === String(selectedUserId)) || null,
    [users, selectedUserId]
  );

  const updateActiveCall = (call) => {
    activeCallRef.current = call;
    setActiveCall(call);
  };

  const updateIncomingCall = (call) => {
    incomingCallRef.current = call;
    setIncomingCall(call);
  };

  const teardownMedia = () => {
    const peer = peerRef.current;
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.close();
      peerRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }

    setLocalStream(null);
    setRemoteStream(null);
    setIsMuted(false);
    setAudioBlocked(false);
    setConnectionState('idle');
  };

  const finishCall = async (status, message) => {
    const call = activeCallRef.current;
    updateActiveCall(null);
    teardownMedia();
    setStatusText(message);
    if (call) {
      await markCall(call.id, { status, ended_at: new Date().toISOString() });
    }
  };

  const openMicrophone = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access requires HTTPS or localhost.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  };

  const playRemoteAudio = () => {
    const audioElement = remoteAudioRef.current;
    if (!audioElement) return;
    audioElement.muted = false;
    audioElement
      .play()
      .then(() => setAudioBlocked(false))
      .catch(() => setAudioBlocked(true));
  };

  const handleConnectionState = (peer) => {
    if (peerRef.current !== peer) return;
    const state = peer.connectionState;
    setConnectionState(state);

    if (state === 'connecting') {
      setStatusText('Negotiating audio path...');
    } else if (state === 'connected') {
      setStatusText('Voice link connected. You can speak now.');
      const call = activeCallRef.current;
      if (call && call.status !== 'connected') {
        markCall(call.id, { status: 'connected', answered_at: call.answered_at || new Date().toISOString() });
      }
    } else if (state === 'disconnected') {
      setStatusText('Connection interrupted, trying to recover...');
    } else if (state === 'failed') {
      finishCall(
        'ended',
        HAS_TURN
          ? 'Could not establish an audio path between the two devices.'
          : 'Could not establish an audio path. The devices are probably on different networks and need a TURN server (see .env.example).'
      );
    }
  };

  const createPeer = (stream) => {
    const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    peer.ontrack = (event) => {
      const incomingStream = event.streams[0] || new MediaStream([event.track]);
      setRemoteStream(incomingStream);
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = incomingStream;
        playRemoteAudio();
      }
    };

    peer.onconnectionstatechange = () => handleConnectionState(peer);

    peerRef.current = peer;
    return peer;
  };

  const handleRealtimeCall = async (call) => {
    if (!call || (call.caller_id !== currentUserId && call.receiver_id !== currentUserId)) return;

    const current = activeCallRef.current;
    if (current && call.id === current.id) {
      if (!ACTIVE_CALL_STATUSES.includes(call.status)) {
        updateActiveCall(null);
        teardownMedia();
        setStatusText(call.status === 'declined' ? 'Call declined.' : 'The other side ended the call.');
        return;
      }

      updateActiveCall(call);

      const peer = peerRef.current;
      if (call.caller_id === currentUserId && call.answer && peer?.signalingState === 'have-local-offer') {
        setStatusText('Receiver joined. Connecting audio...');
        try {
          await peer.setRemoteDescription(call.answer);
        } catch (error) {
          finishCall('ended', getErrorMessage(error));
        }
      }
      return;
    }

    const ringing = incomingCallRef.current;
    if (ringing && call.id === ringing.id && !ACTIVE_CALL_STATUSES.includes(call.status)) {
      updateIncomingCall(null);
      setStatusText('Missed call: the caller hung up.');
      return;
    }

    if (call.receiver_id === currentUserId && call.status === 'pending' && call.offer && !call.answer && !current) {
      updateIncomingCall(call);
      setStatusText('Incoming call ready to join.');
    }
  };

  realtimeHandlerRef.current = handleRealtimeCall;

  useEffect(() => {
    if (!currentUserId) return undefined;
    let cancelled = false;

    const bootstrap = async () => {
      try {
        const { data: userRows, error: usersError } = await supabase
          .from('users')
          .select('id, username, phone_number')
          .order('id');
        if (usersError) throw usersError;
        if (cancelled) return;

        setUsers(userRows || []);
        const firstOther = (userRows || []).find((user) => user.id !== currentUserId);
        setSelectedUserId((previous) => previous || (firstOther ? String(firstOther.id) : ''));

        const { data: openCalls, error: callsError } = await supabase
          .from('calls')
          .select('*')
          .or(`caller_id.eq.${currentUserId},receiver_id.eq.${currentUserId}`)
          .in('status', ACTIVE_CALL_STATUSES)
          .order('started_at', { ascending: false });
        if (callsError) throw callsError;

        // Peer connections don't survive a page reload, so any open call we
        // placed or already answered is dead. Only a fresh ringing call is kept.
        const now = Date.now();
        let ringingCall = null;
        const staleIds = [];
        for (const call of openCalls || []) {
          const isFreshIncoming =
            call.receiver_id === currentUserId &&
            call.status === 'pending' &&
            call.offer &&
            !call.answer &&
            now - Date.parse(call.started_at) < STALE_INCOMING_MS;
          if (isFreshIncoming && !ringingCall) {
            ringingCall = call;
          } else {
            staleIds.push(call.id);
          }
        }

        if (staleIds.length > 0) {
          await supabase.from('calls').update({ status: 'ended', ended_at: new Date().toISOString() }).in('id', staleIds);
        }

        if (!cancelled && ringingCall && !activeCallRef.current) {
          updateIncomingCall(ringingCall);
          setStatusText('Incoming call ready to join.');
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (isMissingCallSchema(message)) {
          setSetupError('Call tables are missing. Run supabase/calls_schema.sql in the Supabase SQL editor first.');
        } else {
          setStatusText(message);
        }
      }
    };

    bootstrap();

    const callsChannel = supabase
      .channel(`calls-realtime-${currentUserId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calls' }, (payload) => {
        realtimeHandlerRef.current?.(payload.new);
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(callsChannel);
    };
  }, [currentUserId]);

  // Hang up when leaving the page.
  useEffect(
    () => () => {
      const call = activeCallRef.current;
      if (call) {
        markCall(call.id, { status: 'ended', ended_at: new Date().toISOString() });
        activeCallRef.current = null;
      }
      teardownMedia();
    },
    []
  );

  // Stop ringing if nobody answers.
  useEffect(() => {
    if (!activeCall || activeCall.status !== 'pending' || activeCall.caller_id !== currentUserId) return undefined;
    const callId = activeCall.id;
    const timer = setTimeout(() => {
      const current = activeCallRef.current;
      if (current?.id === callId && current.status === 'pending') {
        finishCall('ended', 'No answer.');
      }
    }, RING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [activeCall?.id, activeCall?.status, currentUserId]);

  const handleStartCall = async () => {
    if (!selectedUser || activeCallRef.current) return;
    setIsBusy(true);
    setStatusText('Opening microphone...');
    try {
      const stream = await openMicrophone();
      const peer = createPeer(stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      setStatusText('Gathering network routes...');
      await waitForIceGathering(peer);
      if (peerRef.current !== peer) return;

      const { data: insertedCall, error: insertError } = await supabase
        .from('calls')
        .insert([
          {
            caller_id: currentUserId,
            receiver_id: selectedUser.id,
            status: 'pending',
            offer: peer.localDescription.toJSON(),
          },
        ])
        .select()
        .single();
      if (insertError) throw insertError;

      updateActiveCall(insertedCall);
      setStatusText(`Ringing ${selectedUser.username}... waiting for them to join.`);
    } catch (error) {
      await finishCall('ended', getErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleJoinCall = async () => {
    const ringing = incomingCallRef.current;
    if (!ringing) return;
    setIsBusy(true);
    try {
      const { data: latestCall, error: latestCallError } = await supabase
        .from('calls')
        .select('*')
        .eq('id', ringing.id)
        .single();
      if (latestCallError) throw latestCallError;

      if (!ACTIVE_CALL_STATUSES.includes(latestCall.status) || !latestCall.offer) {
        updateIncomingCall(null);
        setStatusText('This call is no longer available.');
        return;
      }

      setStatusText('Opening microphone...');
      const stream = await openMicrophone();
      const peer = createPeer(stream);
      updateIncomingCall(null);
      updateActiveCall(latestCall);

      await peer.setRemoteDescription(latestCall.offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      setStatusText('Gathering network routes...');
      await waitForIceGathering(peer);
      if (peerRef.current !== peer) return;

      const { data: updatedCall, error: updateError } = await supabase
        .from('calls')
        .update({ answer: peer.localDescription.toJSON(), status: 'connecting' })
        .eq('id', latestCall.id)
        .select()
        .single();
      if (updateError) throw updateError;

      if (activeCallRef.current?.id === updatedCall.id) {
        updateActiveCall(updatedCall);
      }
      setStatusText('Joining voice session...');
    } catch (error) {
      await finishCall('ended', getErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleDeclineCall = async () => {
    const ringing = incomingCallRef.current;
    if (!ringing) return;
    updateIncomingCall(null);
    setStatusText('Incoming call declined.');
    await markCall(ringing.id, { status: 'declined', ended_at: new Date().toISOString() });
  };

  const handleEndCall = () => finishCall('ended', 'Call ended.');

  const handleToggleMute = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextMuted = !isMuted;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
  };

  const otherParticipantId = activeCall
    ? activeCall.caller_id === currentUserId
      ? activeCall.receiver_id
      : activeCall.caller_id
    : incomingCall
      ? incomingCall.caller_id
      : null;

  const otherParticipant = users.find((user) => user.id === otherParticipantId);
  const badgeLabel = activeCall ? (connectionState === 'idle' ? activeCall.status : connectionState) : incomingCall ? 'ringing' : 'idle';

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 p-8">
      <div>
        <h1 className="flex items-center gap-3 text-3xl font-bold">
          <PhoneCall className="text-emerald-400" /> Voice Calls
        </h1>
        <p className="mt-2 text-neutral-400">
          Start a direct voice connection with another node. The receiver simply taps join to bridge the audio channel.
        </p>
      </div>

      {setupError && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5 text-amber-100">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle size={18} /> Setup needed
          </div>
          <div className="mt-2 text-sm">{setupError}</div>
          <div className="mt-3 text-xs text-amber-200/80">File to run: `supabase/calls_schema.sql`</div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <section className="rounded-3xl border border-neutral-800 bg-neutral-900 p-6">
          <div className="text-sm uppercase tracking-[0.25em] text-neutral-500">Call Directory</div>
          <div className="mt-5 space-y-3">
            {users
              .filter((user) => user.id !== currentUserId)
              .map((user) => {
                const isSelected = String(user.id) === String(selectedUserId);
                return (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => setSelectedUserId(String(user.id))}
                    className={`w-full rounded-2xl border p-4 text-left transition-colors ${
                      isSelected
                        ? 'border-emerald-500/40 bg-emerald-500/10'
                        : 'border-neutral-800 bg-neutral-950 hover:bg-neutral-900'
                    }`}
                  >
                    <div className="font-medium text-neutral-100">{user.username}</div>
                    <div className="mt-1 text-sm text-neutral-400">{formatParticipant(user)}</div>
                  </button>
                );
              })}
          </div>

          <button
            type="button"
            onClick={handleStartCall}
            disabled={!selectedUser || !!activeCall || !!incomingCall || isBusy || !!setupError}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-5 py-3 font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-700"
          >
            <Phone size={18} /> Call {selectedUser?.username || 'User'}
          </button>

          {!HAS_TURN && (
            <p className="mt-4 text-xs text-neutral-500">
              No TURN relay configured: calls work on the same machine or network, but may fail across different networks.
            </p>
          )}
        </section>

        <section className="rounded-3xl border border-neutral-800 bg-neutral-900 p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm uppercase tracking-[0.25em] text-neutral-500">Call Control</div>
              <div className="mt-2 text-2xl font-semibold text-neutral-100">
                {otherParticipant ? otherParticipant.username : incomingCall ? 'Incoming Call' : 'No Active Call'}
              </div>
            </div>
            <div className="rounded-full border border-neutral-700 px-4 py-2 text-sm text-neutral-300">{badgeLabel}</div>
          </div>

          <div className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
            <div className="flex items-center gap-3 text-neutral-100">
              <Mic size={18} className="text-emerald-400" />
              <span className="font-medium">{statusText}</span>
            </div>
            <div className="mt-3 text-sm text-neutral-500">
              {otherParticipant
                ? `Current path: ${currentUser ? formatParticipant(currentUser) : 'Current user'} -> ${formatParticipant(otherParticipant)}`
                : 'Select a node, place a call, and wait for the other side to join.'}
            </div>

            {activeCall && (
              <div className="mt-5 space-y-3">
                <LevelMeter label="Your microphone" level={localLevel} muted={isMuted} />
                <LevelMeter label={`Audio from ${otherParticipant?.username || 'remote'}`} level={remoteLevel} />
              </div>
            )}
          </div>

          {audioBlocked && (
            <button
              type="button"
              onClick={playRemoteAudio}
              className="mt-6 flex items-center gap-2 rounded-2xl border border-sky-500/30 bg-sky-500/10 px-5 py-3 font-medium text-sky-100 hover:bg-sky-500/20"
            >
              <Volume2 size={18} /> Browser blocked playback. Click to enable audio
            </button>
          )}

          {incomingCall && (
            <div className="mt-6 rounded-2xl border border-sky-500/30 bg-sky-500/10 p-5">
              <div className="flex items-center gap-2 text-sm uppercase tracking-[0.25em] text-sky-200">
                <RadioTower size={16} /> Incoming Call
              </div>
              <div className="mt-3 text-lg font-semibold text-white">
                {users.find((user) => user.id === incomingCall.caller_id)?.username || 'Caller'} wants to connect.
              </div>
              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  onClick={handleJoinCall}
                  disabled={isBusy}
                  className="rounded-xl bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:bg-neutral-700"
                >
                  Join
                </button>
                <button
                  type="button"
                  onClick={handleDeclineCall}
                  disabled={isBusy}
                  className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 font-medium text-red-200 hover:bg-red-500/20"
                >
                  Decline
                </button>
              </div>
            </div>
          )}

          {activeCall && (
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleToggleMute}
                className="flex items-center gap-2 rounded-2xl border border-neutral-700 bg-neutral-800 px-5 py-3 font-medium text-neutral-100 hover:bg-neutral-700"
              >
                {isMuted ? <MicOff size={18} /> : <Mic size={18} />} {isMuted ? 'Unmute' : 'Mute'}
              </button>
              <button
                type="button"
                onClick={handleEndCall}
                className="flex items-center gap-2 rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-3 font-medium text-red-200 hover:bg-red-500/20"
              >
                <PhoneOff size={18} /> End Call
              </button>
            </div>
          )}

          <audio ref={remoteAudioRef} autoPlay playsInline />
        </section>
      </div>
    </div>
  );
}
