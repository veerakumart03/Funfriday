import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './App.css';

const ROOM_SESSION_KEY = 'imposter-room-session';
const DEFAULT_TOTAL_ROUNDS = 3;
const DEFAULT_TURN_SECONDS = 15;

const SOCKET_SERVER_URL = import.meta.env.VITE_SOCKET_SERVER_URL?.trim()
  || (import.meta.env.DEV
    ? 'http://localhost:3001'
    : 'https://imposter-online-exsl.onrender.com');

function createClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readStoredRoomSession() {
  try {
    const rawSession = localStorage.getItem(ROOM_SESSION_KEY);
    if (!rawSession) {
      return null;
    }

    const parsedSession = JSON.parse(rawSession);
    if (!parsedSession?.roomName || !parsedSession?.password || !parsedSession?.username || !parsedSession?.clientId) {
      return null;
    }

    return parsedSession;
  } catch {
    return null;
  }
}

function saveRoomSession(session) {
  localStorage.setItem(ROOM_SESSION_KEY, JSON.stringify(session));
}

function clearRoomSession() {
  localStorage.removeItem(ROOM_SESSION_KEY);
}

function applyRoomState(nextRoomState, roomStateRef, setRoomState, setError, setTotalRoundsInput, setTurnSecondsInput, setSelectedVote) {
  const shouldSyncLobbyConfig =
    !roomStateRef.current ||
    roomStateRef.current.phase !== nextRoomState.phase ||
    nextRoomState.phase !== 'lobby';

  setRoomState(nextRoomState);
  setError(null);

  if (shouldSyncLobbyConfig) {
    setTotalRoundsInput(String(nextRoomState.totalRounds ?? DEFAULT_TOTAL_ROUNDS));
    setTurnSecondsInput(String(nextRoomState.turnSeconds ?? DEFAULT_TURN_SECONDS));
  }

  setSelectedVote((currentSelectedVote) => {
    if (nextRoomState.yourVote) {
      return nextRoomState.yourVote;
    }

    if (nextRoomState.phase === 'voting' && roomStateRef.current?.phase === 'voting') {
      return currentSelectedVote;
    }

    return '';
  });
}

function formatTimeRemaining(timeRemainingMs) {
  const safeMs = Math.max(0, timeRemainingMs);
  const totalSeconds = Math.ceil(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatPhaseLabel(phase) {
  const labels = {
    lobby: 'Lobby',
    wordSelection: 'Word Selection',
    clueing: 'Clueing',
    voting: 'Voting',
    roundResult: 'Round Result',
    finalLeaderboard: 'Final Leaderboard'
  };

  return labels[phase] ?? phase;
}

const socket = io(SOCKET_SERVER_URL, {
  autoConnect: false
});

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState('create');
  const [roomName, setRoomName] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState(null);
  const [roomState, setRoomState] = useState(null);
  const [secretWord, setSecretWord] = useState('');
  const [selectedImposters, setSelectedImposters] = useState([]);
  const [myClue, setMyClue] = useState('');
  const [selectedVote, setSelectedVote] = useState('');
  const [totalRoundsInput, setTotalRoundsInput] = useState(String(DEFAULT_TOTAL_ROUNDS));
  const [turnSecondsInput, setTurnSecondsInput] = useState(String(DEFAULT_TURN_SECONDS));
  const [timeRemainingMs, setTimeRemainingMs] = useState(null);

  const pendingRoomSessionRef = useRef(null);
  const restoreAttemptRef = useRef(false);
  const cluesEndRef = useRef(null);
  const roomStateRef = useRef(null);

  const inRoom = Boolean(roomState);
  const phase = roomState?.phase ?? 'lobby';
  const isAdmin = roomState?.isAdmin ?? false;
  const players = roomState?.players ?? [];
  const currentTurn = roomState?.currentTurn ?? '';
  const yourWord = roomState?.yourWord ?? '';
  const currentUsername = roomState?.yourUsername ?? username;
  const leaderboard = roomState?.leaderboard ?? [];
  const roundResults = roomState?.roundResults;
  const currentRound = roomState?.currentRound ?? 0;
  const totalRounds = roomState?.totalRounds ?? DEFAULT_TOTAL_ROUNDS;
  const turnSeconds = roomState?.turnSeconds ?? DEFAULT_TURN_SECONDS;
  const gameInProgress = phase !== 'lobby';

  useEffect(() => {
    roomStateRef.current = roomState;
  }, [roomState]);

  useEffect(() => {
    const savedSession = readStoredRoomSession();
    if (savedSession) {
      setRoomName(savedSession.roomName);
      setPassword(savedSession.password);
      setUsername(savedSession.username);
      setActiveTab('join');
    }

    const handleConnect = () => {
      setIsConnected(true);
      setError(null);

      const sessionToRestore = readStoredRoomSession();
      if (sessionToRestore) {
        pendingRoomSessionRef.current = sessionToRestore;
        restoreAttemptRef.current = true;
        socket.emit('joinRoom', sessionToRestore);
      }
    };

    const handleDisconnect = () => {
      setIsConnected(false);
    };

    const handleSyncState = (nextRoomState) => {
      applyRoomState(
        nextRoomState,
        roomStateRef,
        setRoomState,
        setError,
        setTotalRoundsInput,
        setTurnSecondsInput,
        setSelectedVote
      );

      if (pendingRoomSessionRef.current) {
        saveRoomSession(pendingRoomSessionRef.current);
        pendingRoomSessionRef.current = null;
      }

      restoreAttemptRef.current = false;
    };

    const handleError = (message) => {
      setError(message);

      if (restoreAttemptRef.current) {
        clearRoomSession();
        restoreAttemptRef.current = false;
      }

      pendingRoomSessionRef.current = null;
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('syncState', handleSyncState);
    socket.on('errorMessage', handleError);
    socket.connect();

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('syncState', handleSyncState);
      socket.off('errorMessage', handleError);
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!roomState?.turnEndsAt) {
      setTimeRemainingMs(null);
      return undefined;
    }

    const updateTimeRemaining = () => {
      setTimeRemainingMs(Math.max(0, roomState.turnEndsAt - Date.now()));
    };

    updateTimeRemaining();
    const intervalId = setInterval(updateTimeRemaining, 250);

    return () => clearInterval(intervalId);
  }, [roomState?.turnEndsAt]);

  useEffect(() => {
    if (!roomState) {
      return;
    }

    if (phase !== 'wordSelection') {
      setSecretWord('');
      setSelectedImposters([]);
    }

    if (roomState.hasSubmittedClue) {
      setMyClue('');
    }
  }, [roomState, phase]);

  useEffect(() => {
    if (cluesEndRef.current) {
      cluesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [roomState?.clues]);

  const resetRoomState = () => {
    setRoomState(null);
    setSecretWord('');
    setSelectedImposters([]);
    setMyClue('');
    setSelectedVote('');
    setTimeRemainingMs(null);
    setTotalRoundsInput(String(DEFAULT_TOTAL_ROUNDS));
    setTurnSecondsInput(String(DEFAULT_TURN_SECONDS));
    setError(null);
  };

  const handleCreateRoom = (event) => {
    event.preventDefault();

    const trimmedRoomName = roomName.trim();
    const trimmedPassword = password.trim();
    const trimmedUsername = username.trim();

    if (!trimmedRoomName || !trimmedPassword || !trimmedUsername) {
      setError('Please fill in all fields.');
      return;
    }

    setError(null);
    const session = {
      roomName: trimmedRoomName,
      password: trimmedPassword,
      username: trimmedUsername,
      clientId: createClientId()
    };
    pendingRoomSessionRef.current = session;
    restoreAttemptRef.current = false;
    socket.emit('createRoom', session, (response) => {
      if (!response?.ok || !response.roomState) {
        return;
      }

      applyRoomState(
        response.roomState,
        roomStateRef,
        setRoomState,
        setError,
        setTotalRoundsInput,
        setTurnSecondsInput,
        setSelectedVote
      );
      saveRoomSession(session);
      pendingRoomSessionRef.current = null;
    });
  };

  const handleJoinRoom = (event) => {
    event.preventDefault();

    const trimmedRoomName = roomName.trim();
    const trimmedPassword = password.trim();
    const trimmedUsername = username.trim();

    if (!trimmedRoomName || !trimmedPassword || !trimmedUsername) {
      setError('Please fill in all fields.');
      return;
    }

    setError(null);
    const session = {
      roomName: trimmedRoomName,
      password: trimmedPassword,
      username: trimmedUsername,
      clientId: createClientId()
    };
    pendingRoomSessionRef.current = session;
    restoreAttemptRef.current = false;
    socket.emit('joinRoom', session, (response) => {
      if (!response?.ok || !response.roomState) {
        return;
      }

      applyRoomState(
        response.roomState,
        roomStateRef,
        setRoomState,
        setError,
        setTotalRoundsInput,
        setTurnSecondsInput,
        setSelectedVote
      );
      saveRoomSession(session);
      pendingRoomSessionRef.current = null;
    });
  };

  const handleLeaveRoom = () => {
    clearRoomSession();
    pendingRoomSessionRef.current = null;
    restoreAttemptRef.current = false;
    socket.emit('leaveRoom');
    resetRoomState();
  };

  const handleStartGame = () => {
    setError(null);
    socket.emit('startGame', {
      totalRounds: Number(totalRoundsInput),
      turnSeconds: Number(turnSecondsInput)
    });
  };

  const handleShareWord = (event) => {
    event.preventDefault();

    if (!secretWord.trim()) {
      setError('Please enter a secret word.');
      return;
    }

    if (selectedImposters.length === 0) {
      setError('Please choose at least one imposter for this round.');
      return;
    }

    if (selectedImposters.length >= players.length) {
      setError('At least one non-imposter player is required.');
      return;
    }

    setError(null);
    socket.emit('shareWord', {
      word: secretWord,
      imposterUsernames: selectedImposters
    });
  };

  const handleToggleImposter = (playerUsername) => {
    setSelectedImposters((currentSelectedImposters) => (
      currentSelectedImposters.includes(playerUsername)
        ? currentSelectedImposters.filter((name) => name !== playerUsername)
        : [...currentSelectedImposters, playerUsername]
    ));
  };

  const handleSubmitClue = (event) => {
    event.preventDefault();

    if (!myClue.trim()) {
      return;
    }

    setError(null);
    socket.emit('sendClue', { clue: myClue });
  };

  const handleSubmitVote = (event) => {
    event.preventDefault();

    if (!selectedVote) {
      setError('Please select who you think the imposter is.');
      return;
    }

    setError(null);
    socket.emit('submitVote', { suspectedPlayer: selectedVote });
  };

  const handleStartNextRound = () => {
    setError(null);
    socket.emit('startNextRound');
  };

  const voteOptions = players.filter((player) => player.username !== currentUsername);
  const timerLabel = timeRemainingMs !== null ? formatTimeRemaining(timeRemainingMs) : null;

  return (
    <div className="app-container">
      <header>
        <h1>Imposter</h1>
        <p style={{ textAlign: 'center', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
          {isConnected ? (
            <span style={{ color: 'var(--success)' }}>● Server Connected</span>
          ) : (
            <span style={{ color: 'var(--danger)' }}>
              ○ Server Offline
              {import.meta.env.DEV ? ' - start the backend with `npm run dev` from the project root' : ''}
            </span>
          )}
        </p>
      </header>

      {error && <div className="alert alert-danger" id="alert-error-msg">{error}</div>}

      {!inRoom ? (
        <div className="card">
          <div className="tabs">
            <button
              id="tab-create-room"
              className={`tab ${activeTab === 'create' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('create');
                setError(null);
              }}
            >
              Create Room
            </button>
            <button
              id="tab-join-room"
              className={`tab ${activeTab === 'join' ? 'active' : ''}`}
              onClick={() => {
                setActiveTab('join');
                setError(null);
              }}
            >
              Join Room
            </button>
          </div>

          {activeTab === 'create' ? (
            <form onSubmit={handleCreateRoom} id="form-create-room">
              <h2>Create a Room</h2>
              <div className="form-group">
                <label htmlFor="create-username">Username</label>
                <input
                  id="create-username"
                  type="text"
                  placeholder="Enter your username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  maxLength={15}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="create-room-name">Room Name</label>
                <input
                  id="create-room-name"
                  type="text"
                  placeholder="Enter room name"
                  value={roomName}
                  onChange={(event) => setRoomName(event.target.value)}
                  maxLength={15}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="create-password">Room Password</label>
                <input
                  id="create-password"
                  type="password"
                  placeholder="Enter room password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>
              <button type="submit" id="btn-create-submit" className="btn btn-primary" style={{ marginTop: '1rem' }}>
                Create & Join
              </button>
            </form>
          ) : (
            <form onSubmit={handleJoinRoom} id="form-join-room">
              <h2>Join a Room</h2>
              <div className="form-group">
                <label htmlFor="join-username">Username</label>
                <input
                  id="join-username"
                  type="text"
                  placeholder="Enter your username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  maxLength={15}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="join-room-name">Room Name</label>
                <input
                  id="join-room-name"
                  type="text"
                  placeholder="Enter room name"
                  value={roomName}
                  onChange={(event) => setRoomName(event.target.value)}
                  maxLength={15}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="join-password">Room Password</label>
                <input
                  id="join-password"
                  type="password"
                  placeholder="Enter room password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>
              <button type="submit" id="btn-join-submit" className="btn btn-primary" style={{ marginTop: '1rem' }}>
                Join Room
              </button>
            </form>
          )}
        </div>
      ) : (
        <div className="game-grid">
          <div className="card room-header-card">
            <div style={{ textAlign: 'left' }}>
              <p style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Current Room</p>
              <h3 style={{ margin: 0, fontSize: '1.4rem', color: 'var(--text-primary)' }}>{roomState.roomName}</h3>
            </div>
            <button
              id="btn-leave-room"
              className="btn btn-secondary"
              onClick={handleLeaveRoom}
              style={{ width: 'auto', padding: '0.5rem 1rem', fontSize: '0.9rem' }}
            >
              Leave Room
            </button>
          </div>

          <div className="card">
            <div className="meta-grid">
              <div>
                <p className="meta-label">Phase</p>
                <div className="phase-badge">{formatPhaseLabel(phase)}</div>
              </div>
              <div>
                <p className="meta-label">Round</p>
                <p className="meta-value">{gameInProgress ? `${currentRound} / ${totalRounds}` : 'Not started'}</p>
              </div>
              <div>
                <p className="meta-label">Turn Time</p>
                <p className="meta-value">{turnSeconds}s per player</p>
              </div>
              {timerLabel && (
                <div>
                  <p className="meta-label">Timer</p>
                  <p className="timer-pill">{timerLabel}</p>
                </div>
              )}
            </div>
          </div>

          {!gameInProgress ? (
            <div className="card" id="lobby-card">
              <h2>Lobby Room</h2>
              <p style={{ marginBottom: '1.5rem' }}>Waiting for players to join. Current player count: {players.length}</p>

              <div className="players-container">
                <h3>Active Players</h3>
                <div className="players-list">
                  {players.map((player) => (
                    <div key={player.username} className={`player-badge ${player.isAdmin ? 'admin' : ''}`} id={`lobby-player-${player.username}`}>
                      {player.isAdmin && <span className="crown-icon">👑</span>}
                      <span className="player-name">{player.username}</span>
                      <span className={`player-role-tag ${player.isAdmin ? 'admin-tag' : 'player-tag'}`}>
                        {player.isAdmin ? 'Admin' : 'Player'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {isAdmin ? (
                <div className="config-panel">
                  <h3>Game Setup</h3>
                  <div className="config-grid">
                    <div className="form-group">
                      <label htmlFor="total-rounds">Total Rounds</label>
                      <input
                        id="total-rounds"
                        type="text"
                        inputMode="numeric"
                        value={totalRoundsInput}
                        onChange={(event) => setTotalRoundsInput(event.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="turn-seconds">Turn Time Per Player (Seconds)</label>
                      <input
                        id="turn-seconds"
                        type="text"
                        inputMode="numeric"
                        value={turnSecondsInput}
                        onChange={(event) => setTurnSecondsInput(event.target.value)}
                      />
                    </div>
                  </div>
                  <button id="btn-start-game" className="btn btn-primary" onClick={handleStartGame}>
                    Start Game
                  </button>
                </div>
              ) : (
                <div className="alert alert-info" id="lobby-wait-msg" style={{ marginTop: '2rem', justifyContent: 'center' }}>
                  Waiting for host to choose rounds and start the game...
                </div>
              )}
            </div>
          ) : (
            <div className="card" id="game-card">
              <h2>{phase === 'finalLeaderboard' ? 'Game Finished' : 'Game In Progress'}</h2>

              {yourWord && phase !== 'wordSelection' && (
                <div className="word-card" id="secret-word-card" style={{ marginBottom: '1.5rem' }}>
                  <p className="word-label">Your Clue Target</p>
                  <p className={`secret-word ${yourWord === 'IMPOSTER' ? 'imposter' : 'normal'}`} id="secret-word-display">
                    {yourWord}
                  </p>
                </div>
              )}

              {phase === 'wordSelection' && (
                <>
                  {isAdmin ? (
                    <form onSubmit={handleShareWord} className="card admin-panel" id="admin-setup-form">
                      <h3 style={{ color: 'var(--warning)', marginTop: 0 }}>Round Setup</h3>
                      <p style={{ marginBottom: '1rem' }}>Choose the secret word and who the imposters are for round {currentRound}.</p>

                      <div className="form-group">
                        <label htmlFor="admin-secret-word">Secret Word</label>
                        <input
                          id="admin-secret-word"
                          type="text"
                          placeholder="Enter the secret word"
                          value={secretWord}
                          onChange={(event) => setSecretWord(event.target.value)}
                          required
                        />
                      </div>

                      <div className="form-group">
                        <label>Select The Imposter(s)</label>
                        <div className="imposters-selection" id="imposters-checklist">
                          {players.map((player) => (
                            <label key={player.username} className="checkbox-label" htmlFor={`imposter-option-${player.username}`}>
                              <input
                                id={`imposter-option-${player.username}`}
                                type="checkbox"
                                checked={selectedImposters.includes(player.username)}
                                onChange={() => handleToggleImposter(player.username)}
                              />
                              <span>{player.username} {player.isAdmin ? '(You - Admin)' : ''}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <button type="submit" id="btn-share-word" className="btn btn-primary">
                        Start Round
                      </button>
                    </form>
                  ) : (
                    <div className="alert alert-info" id="game-wait-word-msg" style={{ marginBottom: '1.5rem' }}>
                      Waiting for the host to set up round {currentRound}...
                    </div>
                  )}
                </>
              )}

              {phase === 'clueing' && (
                <div style={{ marginTop: '1rem' }}>
                  {currentTurn && (
                    <div className={`clue-turn-indicator ${currentTurn === currentUsername ? 'your-turn' : 'other-turn'}`} id="clue-turn-status">
                      {currentTurn === currentUsername
                        ? 'Your turn is live. Submit your clue before the timer ends.'
                        : `Waiting for ${currentTurn} to submit a clue...`}
                    </div>
                  )}

                  {currentTurn === currentUsername && !roomState?.hasSubmittedClue && (
                    <form onSubmit={handleSubmitClue} className="clue-input-box" id="form-submit-clue">
                      <input
                        id="clue-input"
                        type="text"
                        placeholder="Enter a one-word clue"
                        value={myClue}
                        onChange={(event) => setMyClue(event.target.value)}
                        required
                        maxLength={20}
                      />
                      <button type="submit" id="btn-submit-clue" className="btn btn-primary">
                        Send Clue
                      </button>
                    </form>
                  )}

                  {currentTurn !== currentUsername && !roomState?.hasSubmittedClue && (
                    <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
                      Your clue box will appear when your turn starts.
                    </div>
                  )}

                  {roomState?.hasSubmittedClue && (
                    <div className="alert alert-success" style={{ marginBottom: '1rem' }}>
                      Your clue has been submitted for this round.
                    </div>
                  )}
                </div>
              )}

              {(phase === 'clueing' || phase === 'voting' || phase === 'roundResult' || phase === 'finalLeaderboard') && (
                <div className="clues-list-container">
                  <h3>Clues Submitted</h3>
                  {roomState?.clues?.length === 0 ? (
                    <p style={{ fontStyle: 'italic', fontSize: '0.9rem' }} id="no-clues-msg">No clues submitted yet.</p>
                  ) : (
                    <div className="clues-list" id="clues-log">
                      {roomState.clues.map((item, index) => (
                        <div key={`${item.username}-${index}`} className="clue-item" id={`clue-item-${index}`}>
                          <span className="clue-username">{item.username}</span>
                          <span className="clue-text">{item.clue}</span>
                        </div>
                      ))}
                      <div ref={cluesEndRef} />
                    </div>
                  )}
                </div>
              )}

              {phase === 'voting' && (
                <div className="vote-panel">
                  <h3>Vote For The Imposter</h3>
                  <p style={{ marginBottom: '1rem' }}>Select who you think the imposter is. A correct vote earns points. A wrong vote halves your current score.</p>

                  <form onSubmit={handleSubmitVote}>
                    <div className="vote-selection">
                      {voteOptions.map((player) => (
                        <label key={player.username} className="checkbox-label vote-option" htmlFor={`vote-${player.username}`}>
                          <input
                            id={`vote-${player.username}`}
                            type="radio"
                            name="suspected-player"
                            checked={selectedVote === player.username}
                            onChange={() => setSelectedVote(player.username)}
                          />
                          <span>{player.username}</span>
                        </label>
                      ))}
                    </div>

                    <button type="submit" className="btn btn-primary" style={{ marginTop: '1rem' }}>
                      Submit Vote
                    </button>
                  </form>

                  {roomState?.yourVote && (
                    <div className="alert alert-success" style={{ marginTop: '1rem' }}>
                      Your vote is locked on <strong>{roomState.yourVote}</strong>. Waiting for the other players.
                    </div>
                  )}
                </div>
              )}

              {(phase === 'roundResult' || phase === 'finalLeaderboard') && roundResults && (
                <div className="result-reveal-box" id="imposter-reveal-box">
                  <div className="reveal-title">Round {roundResults.roundNumber} Results</div>
                  <div className="imposter-names" id="revealed-imposter-names">
                    {roundResults.actualImposters.join(', ')}
                  </div>
                  <div className="round-results-list">
                    {roundResults.votes.map((result) => (
                      <div key={result.username} className="round-result-item">
                        <span className="round-result-name">{result.username}</span>
                        <span className="round-result-detail">
                          voted {result.selectedPlayer || 'nobody'} • {result.guessedCorrectly ? `+${result.scoreChange}` : `${result.scoreChange}`} pts
                          {result.earnedImposterBonus ? ' • undetected imposter bonus' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                  {roundResults.undetectedImposters?.length > 0 && (
                    <p style={{ marginTop: '1rem', marginBottom: 0 }}>
                      Undetected imposters: <strong>{roundResults.undetectedImposters.join(', ')}</strong>
                    </p>
                  )}
                </div>
              )}

              {(phase === 'roundResult' || phase === 'finalLeaderboard') && (
                <div className="leaderboard-panel">
                  <h3>{phase === 'finalLeaderboard' ? 'Final Leaderboard' : 'Current Leaderboard'}</h3>
                  <div className="leaderboard-list">
                    {leaderboard.map((player, index) => (
                      <div key={player.username} className="leaderboard-row">
                        <span className="leaderboard-rank">#{index + 1}</span>
                        <span className="leaderboard-name">{player.username}</span>
                        <span className="leaderboard-score">{player.score} pts</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {phase === 'roundResult' && isAdmin && (
                <div style={{ marginTop: '1.5rem' }}>
                  <button id="btn-next-round" className="btn btn-primary" onClick={handleStartNextRound}>
                    Start Round {currentRound + 1}
                  </button>
                </div>
              )}

              {phase === 'roundResult' && !isAdmin && (
                <div className="alert alert-info" style={{ marginTop: '1.5rem' }}>
                  Waiting for the host to start the next round...
                </div>
              )}

              {phase === 'finalLeaderboard' && (
                <div className="alert alert-success" style={{ marginTop: '1.5rem' }}>
                  All {totalRounds} rounds are complete. The leaderboard above is the final result.
                </div>
              )}
            </div>
          )}

          <div className="card" id="game-players-card" style={{ padding: '1.5rem' }}>
            <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem', textAlign: 'left' }}>Players & Scores</h3>
            <div className="players-list">
              {players.map((player) => (
                <div
                  key={player.username}
                  className={`player-badge ${player.isAdmin ? 'admin' : ''} ${player.isImposterRevealed ? 'imposter-revealed' : ''}`}
                  id={`game-player-${player.username}`}
                >
                  {player.isAdmin && <span className="crown-icon">👑</span>}
                  <span className="player-name">{player.username}</span>
                  <span className="score-chip">{player.score} pts</span>
                  {!player.isConnected && <span className="player-role-tag reconnecting-tag">Rejoining</span>}
                  {player.isImposterRevealed ? (
                    <span className="player-role-tag imposter-tag">Imposter</span>
                  ) : (
                    <span className={`player-role-tag ${player.isAdmin ? 'admin-tag' : 'player-tag'}`}>
                      {player.isAdmin ? 'Admin' : 'Player'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
