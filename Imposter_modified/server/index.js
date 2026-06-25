const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const PLAYER_DISCONNECT_GRACE_MS = 30000;
const ROUND_POINTS = 10;
const UNDETECTED_IMPOSTER_POINTS = ROUND_POINTS * 2;
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 15;
const MIN_TURN_SECONDS = 10;
const MAX_TURN_SECONDS = 180;

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const rooms = {};

function createInitialGameState() {
  return {
    phase: 'lobby',
    totalRounds: 3,
    turnSeconds: 15,
    currentRound: 0,
    secretWord: '',
    clues: [],
    currentTurn: 0,
    turnEndsAt: null,
    turnTimer: null,
    roundResults: null
  };
}

function clearDisconnectTimer(player) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
}

function clearTurnTimer(room) {
  if (room.game.turnTimer) {
    clearTimeout(room.game.turnTimer);
    room.game.turnTimer = null;
  }
  room.game.turnEndsAt = null;
}

function clearRoomTimers(room) {
  clearTurnTimer(room);
  room.players.forEach(clearDisconnectTimer);
}

function createPlayer(socket, username, clientId) {
  return {
    id: socket.id,
    clientId,
    username,
    connected: true,
    disconnectTimer: null,
    score: 0,
    isImposter: false,
    hasSubmittedClue: false,
    vote: null
  };
}

function resetRoundPlayerState(player) {
  player.isImposter = false;
  player.hasSubmittedClue = false;
  player.vote = null;
}

function bindPlayerToSocket(socket, roomName, room, player) {
  const previousSocketId = player.id;

  socket.roomName = roomName;
  socket.username = player.username;
  socket.clientId = player.clientId;
  socket.join(roomName);

  player.id = socket.id;
  player.connected = true;
  clearDisconnectTimer(player);

  if (room.admin === previousSocketId) {
    room.admin = socket.id;
  }
}

function isUsernameTaken(room, username) {
  return room.players.some((player) => player.username.toLowerCase() === username.toLowerCase());
}

function findPlayerByClientId(room, clientId) {
  if (!clientId) {
    return null;
  }

  return room.players.find((player) => player.clientId === clientId) || null;
}

function getLeaderboard(room) {
  return [...room.players]
    .map((player) => ({
      username: player.username,
      score: player.score,
      isAdmin: player.id === room.admin
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.username.localeCompare(right.username);
    });
}

function getActualImposterNames(room) {
  return room.players.filter((player) => player.isImposter).map((player) => player.username);
}

function buildRoundResults(room) {
  if (!room.game.roundResults) {
    return null;
  }

  return {
    roundNumber: room.game.roundResults.roundNumber,
    actualImposters: [...room.game.roundResults.actualImposters],
    undetectedImposters: [...room.game.roundResults.undetectedImposters],
    votes: room.game.roundResults.votes.map((vote) => ({ ...vote })),
    pointsPerCorrectVote: room.game.roundResults.pointsPerCorrectVote,
    pointsPerUndetectedImposter: room.game.roundResults.pointsPerUndetectedImposter
  };
}

function buildStateForPlayer(room, player) {
  const revealResults = room.game.phase === 'roundResult' || room.game.phase === 'finalLeaderboard';
  const currentTurnPlayer = room.players[room.game.currentTurn];
  const yourWord = room.game.secretWord
    ? (player.isImposter ? 'IMPOSTER' : room.game.secretWord)
    : '';

  return {
    roomName: room.name,
    phase: room.game.phase,
    isStarted: room.game.phase !== 'lobby',
    isAdmin: room.admin === player.id,
    yourUsername: player.username,
    totalRounds: room.game.totalRounds,
    turnSeconds: room.game.turnSeconds,
    currentRound: room.game.currentRound,
    currentTurn: room.game.phase === 'clueing' && currentTurnPlayer ? currentTurnPlayer.username : '',
    turnEndsAt: room.game.turnEndsAt,
    clues: room.game.clues.map((clue) => ({ ...clue })),
    players: room.players.map((roomPlayer) => ({
      username: roomPlayer.username,
      isAdmin: roomPlayer.id === room.admin,
      isConnected: roomPlayer.connected,
      score: roomPlayer.score,
      hasSubmittedClue: roomPlayer.hasSubmittedClue,
      hasVoted: Boolean(roomPlayer.vote),
      vote: revealResults ? roomPlayer.vote : null,
      isImposterRevealed: revealResults && roomPlayer.isImposter
    })),
    yourWord,
    yourVote: player.vote,
    hasSubmittedClue: player.hasSubmittedClue,
    leaderboard: getLeaderboard(room),
    roundResults: buildRoundResults(room)
  };
}

function emitRoomState(roomName) {
  const room = rooms[roomName];
  if (!room) {
    return;
  }

  room.players.forEach((player) => {
    const targetSocket = io.sockets.sockets.get(player.id);
    if (targetSocket) {
      io.to(player.id).emit('syncState', buildStateForPlayer(room, player));
    }
  });
}

function emitError(socket, ack, message) {
  socket.emit('errorMessage', message);

  if (typeof ack === 'function') {
    ack({ ok: false, error: message });
  }
}

function respondWithRoomState(room, player, ack) {
  if (typeof ack === 'function') {
    ack({
      ok: true,
      roomState: buildStateForPlayer(room, player)
    });
  }
}

function enterWordSelection(room) {
  clearTurnTimer(room);
  room.game.phase = 'wordSelection';
  room.game.secretWord = '';
  room.game.clues = [];
  room.game.currentTurn = 0;
  room.game.roundResults = null;
  room.players.forEach(resetRoundPlayerState);
}

function startVoting(room) {
  clearTurnTimer(room);
  room.game.phase = 'voting';
  room.players.forEach((player) => {
    player.vote = null;
  });
  emitRoomState(room.name);
}

function findNextClueTurnIndex(room, startingIndex) {
  for (let offset = 0; offset < room.players.length; offset += 1) {
    const candidateIndex = (startingIndex + offset) % room.players.length;
    if (!room.players[candidateIndex].hasSubmittedClue) {
      return candidateIndex;
    }
  }

  return -1;
}

function advanceClueTurn(room, startingIndex) {
  if (!rooms[room.name]) {
    return;
  }

  clearTurnTimer(room);

  if (room.players.length === 0) {
    return;
  }

  const nextTurnIndex = findNextClueTurnIndex(room, startingIndex);
  if (nextTurnIndex === -1) {
    startVoting(room);
    return;
  }

  room.game.phase = 'clueing';
  room.game.currentTurn = nextTurnIndex;
  room.game.turnEndsAt = Date.now() + (room.game.turnSeconds * 1000);
  room.game.turnTimer = setTimeout(() => {
    const latestRoom = rooms[room.name];
    if (!latestRoom || latestRoom.game.phase !== 'clueing' || latestRoom.players.length === 0) {
      return;
    }

    const activePlayer = latestRoom.players[latestRoom.game.currentTurn];
    if (!activePlayer || activePlayer.hasSubmittedClue) {
      return;
    }

    activePlayer.hasSubmittedClue = true;
    latestRoom.game.clues.push({
      username: activePlayer.username,
      clue: '(Skipped)',
      autoSkipped: true
    });

    advanceClueTurn(latestRoom, latestRoom.game.currentTurn + 1);
  }, room.game.turnSeconds * 1000);

  emitRoomState(room.name);
}

function processVotes(room) {
  const actualImposters = getActualImposterNames(room);
  const voteCounts = room.players.reduce((counts, player) => {
    if (player.vote) {
      counts[player.vote] = (counts[player.vote] || 0) + 1;
    }

    return counts;
  }, {});
  const undetectedImposters = actualImposters.filter((username) => !voteCounts[username]);
  const voteResults = room.players.map((player) => {
    const previousScore = player.score;
    const guessedCorrectly = actualImposters.includes(player.vote);
    const earnedImposterBonus = player.isImposter && undetectedImposters.includes(player.username);

    if (guessedCorrectly) {
      player.score += ROUND_POINTS;
    } else {
      player.score = Math.max(0, Math.floor(player.score / 2));
    }

    if (earnedImposterBonus) {
      player.score += UNDETECTED_IMPOSTER_POINTS;
    }

    return {
      username: player.username,
      selectedPlayer: player.vote,
      guessedCorrectly,
      earnedImposterBonus,
      wasImposter: player.isImposter,
      scoreChange: player.score - previousScore,
      newScore: player.score
    };
  });

  clearTurnTimer(room);
  room.game.roundResults = {
    roundNumber: room.game.currentRound,
    actualImposters,
    undetectedImposters,
    votes: voteResults,
    pointsPerCorrectVote: ROUND_POINTS,
    pointsPerUndetectedImposter: UNDETECTED_IMPOSTER_POINTS
  };
  room.game.phase = room.game.currentRound >= room.game.totalRounds
    ? 'finalLeaderboard'
    : 'roundResult';

  emitRoomState(room.name);
}

function maybeFinishVoting(room) {
  if (room.players.length > 0 && room.players.every((player) => player.vote)) {
    processVotes(room);
  } else {
    emitRoomState(room.name);
  }
}

function removePlayerFromRoom(roomName, clientId) {
  const room = rooms[roomName];
  if (!room) {
    return;
  }

  const index = room.players.findIndex((player) => player.clientId === clientId);
  if (index === -1) {
    return;
  }

  const removedPlayer = room.players[index];
  const removedCurrentTurn = room.game.phase === 'clueing' && index === room.game.currentTurn;
  clearDisconnectTimer(removedPlayer);
  room.players.splice(index, 1);

  if (room.players.length === 0) {
    clearRoomTimers(room);
    delete rooms[roomName];
    console.log(`Room ${roomName} is empty. Deleting.`);
    return;
  }

  if (room.admin === removedPlayer.id) {
    room.admin = room.players[0].id;
    io.to(room.admin).emit('syncState', buildStateForPlayer(room, room.players[0]));
    console.log(`Admin left room ${roomName}. New admin is ${room.players[0].username}`);
  }

  if (room.game.phase === 'clueing') {
    if (room.players.every((player) => player.hasSubmittedClue)) {
      startVoting(room);
      return;
    }

    if (index < room.game.currentTurn) {
      room.game.currentTurn -= 1;
    } else if (room.game.currentTurn >= room.players.length) {
      room.game.currentTurn = 0;
    }

    if (removedCurrentTurn) {
      advanceClueTurn(room, room.game.currentTurn);
      return;
    }
  }

  if (room.game.phase === 'voting') {
    maybeFinishVoting(room);
    return;
  }

  emitRoomState(roomName);
}

function parsePositiveInteger(value) {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue)) {
    return null;
  }

  return parsedValue;
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('createRoom', ({ roomName, password, username, clientId }, ack) => {
    if (!roomName || !password || !username || !clientId) {
      return emitError(socket, ack, 'Room name, password, and username are required.');
    }

    const trimmedRoom = roomName.trim();
    const trimmedUser = username.trim();

    if (rooms[trimmedRoom]) {
      return emitError(socket, ack, `Room "${trimmedRoom}" already exists.`);
    }

    const room = {
      name: trimmedRoom,
      password,
      admin: socket.id,
      players: [createPlayer(socket, trimmedUser, clientId)],
      game: createInitialGameState()
    };

    rooms[trimmedRoom] = room;

    socket.roomName = trimmedRoom;
    socket.username = trimmedUser;
    socket.clientId = clientId;
    socket.join(trimmedRoom);

    respondWithRoomState(room, room.players[0], ack);
    emitRoomState(trimmedRoom);
  });

  socket.on('joinRoom', ({ roomName, password, username, clientId }, ack) => {
    if (!roomName || !password || !username || !clientId) {
      return emitError(socket, ack, 'Room name, password, and username are required.');
    }

    const trimmedRoom = roomName.trim();
    const trimmedUser = username.trim();
    const room = rooms[trimmedRoom];

    if (!room) {
      return emitError(socket, ack, `Room "${trimmedRoom}" does not exist.`);
    }

    if (room.password !== password) {
      return emitError(socket, ack, 'Incorrect password.');
    }

    const reconnectingPlayer = findPlayerByClientId(room, clientId);
    if (reconnectingPlayer) {
      if (reconnectingPlayer.connected) {
        const previousSocket = io.sockets.sockets.get(reconnectingPlayer.id);
        if (previousSocket) {
          previousSocket.skipRoomCleanup = true;
          previousSocket.disconnect(true);
        }
      }

      bindPlayerToSocket(socket, trimmedRoom, room, reconnectingPlayer);
      respondWithRoomState(room, reconnectingPlayer, ack);
      emitRoomState(trimmedRoom);
      return;
    }

    if (room.game.phase !== 'lobby') {
      return emitError(socket, ack, 'This game is already in progress. Only existing players can rejoin.');
    }

    if (isUsernameTaken(room, trimmedUser)) {
      return emitError(socket, ack, `Username "${trimmedUser}" is already taken in this room.`);
    }

    const player = createPlayer(socket, trimmedUser, clientId);
    room.players.push(player);

    socket.roomName = trimmedRoom;
    socket.username = trimmedUser;
    socket.clientId = clientId;
    socket.join(trimmedRoom);

    respondWithRoomState(room, player, ack);
    emitRoomState(trimmedRoom);
  });

  socket.on('leaveRoom', () => {
    const roomName = socket.roomName;
    const clientId = socket.clientId;

    if (roomName && clientId) {
      removePlayerFromRoom(roomName, clientId);
    }

    if (roomName) {
      socket.leave(roomName);
    }

    delete socket.roomName;
    delete socket.username;
    delete socket.clientId;
  });

  socket.on('startGame', ({ totalRounds, turnSeconds }) => {
    const roomName = socket.roomName;
    const room = rooms[roomName];

    if (!room) {
      return socket.emit('errorMessage', 'Room not found.');
    }

    if (room.admin !== socket.id) {
      return socket.emit('errorMessage', 'Only the Admin can start the game.');
    }

    if (room.players.length < 3) {
      return socket.emit('errorMessage', 'At least 3 players are required to start the game.');
    }

    const parsedRounds = parsePositiveInteger(totalRounds);
    const parsedTurnSeconds = parsePositiveInteger(turnSeconds);

    if (!parsedRounds || parsedRounds < MIN_ROUNDS || parsedRounds > MAX_ROUNDS) {
      return socket.emit('errorMessage', `Total rounds must be between ${MIN_ROUNDS} and ${MAX_ROUNDS}.`);
    }

    if (!parsedTurnSeconds || parsedTurnSeconds < MIN_TURN_SECONDS || parsedTurnSeconds > MAX_TURN_SECONDS) {
      return socket.emit('errorMessage', `Turn time must be between ${MIN_TURN_SECONDS} and ${MAX_TURN_SECONDS} seconds.`);
    }

    room.players.forEach((player) => {
      player.score = 0;
    });

    room.game.totalRounds = parsedRounds;
    room.game.turnSeconds = parsedTurnSeconds;
    room.game.currentRound = 1;
    enterWordSelection(room);
    emitRoomState(roomName);
  });

  socket.on('startNextRound', () => {
    const roomName = socket.roomName;
    const room = rooms[roomName];

    if (!room) {
      return socket.emit('errorMessage', 'Room not found.');
    }

    if (room.admin !== socket.id) {
      return socket.emit('errorMessage', 'Only the Admin can start the next round.');
    }

    if (room.game.phase !== 'roundResult') {
      return socket.emit('errorMessage', 'The next round is not available yet.');
    }

    room.game.currentRound += 1;
    enterWordSelection(room);
    emitRoomState(roomName);
  });

  socket.on('shareWord', ({ word, imposterUsernames, imposterUsername }) => {
    const roomName = socket.roomName;
    const room = rooms[roomName];

    if (!room) {
      return socket.emit('errorMessage', 'Room not found.');
    }

    if (room.admin !== socket.id) {
      return socket.emit('errorMessage', 'Only the Admin can share the word.');
    }

    if (room.game.phase !== 'wordSelection') {
      return socket.emit('errorMessage', 'This round is not ready for word selection.');
    }

    const trimmedWord = word ? word.trim() : '';
    if (!trimmedWord) {
      return socket.emit('errorMessage', 'Word cannot be empty.');
    }

    const normalizedImposters = Array.isArray(imposterUsernames)
      ? imposterUsernames
      : [imposterUsername];
    const uniqueImposterUsernames = [...new Set(
      normalizedImposters
        .filter(Boolean)
        .map((username) => username.trim())
        .filter(Boolean)
    )];

    if (uniqueImposterUsernames.length === 0) {
      return socket.emit('errorMessage', 'Please select at least one valid imposter.');
    }

    if (uniqueImposterUsernames.length >= room.players.length) {
      return socket.emit('errorMessage', 'At least one non-imposter player is required.');
    }

    const hasInvalidImposter = uniqueImposterUsernames.some((username) => (
      !room.players.some((player) => player.username === username)
    ));

    if (hasInvalidImposter) {
      return socket.emit('errorMessage', 'Please select only players from this room as imposters.');
    }

    room.game.secretWord = trimmedWord;
    room.game.clues = [];
    room.game.roundResults = null;
    room.players.forEach((player) => {
      resetRoundPlayerState(player);
      player.isImposter = uniqueImposterUsernames.includes(player.username);
    });

    advanceClueTurn(room, 0);
  });

  socket.on('sendClue', ({ clue }) => {
    const roomName = socket.roomName;
    const room = rooms[roomName];

    if (!room) {
      return socket.emit('errorMessage', 'Room not found.');
    }

    if (room.game.phase !== 'clueing') {
      return socket.emit('errorMessage', 'Clue submission is not active right now.');
    }

    const player = room.players.find((roomPlayer) => roomPlayer.id === socket.id);
    if (!player) {
      return socket.emit('errorMessage', 'Player not found.');
    }

    const activePlayer = room.players[room.game.currentTurn];
    if (!activePlayer || activePlayer.id !== socket.id) {
      return socket.emit('errorMessage', 'It is not your turn.');
    }

    const trimmedClue = clue ? clue.trim() : '';
    if (!trimmedClue) {
      return socket.emit('errorMessage', 'Clue cannot be empty.');
    }

    player.hasSubmittedClue = true;
    room.game.clues.push({
      username: player.username,
      clue: trimmedClue,
      autoSkipped: false
    });

    advanceClueTurn(room, room.game.currentTurn + 1);
  });

  socket.on('submitVote', ({ suspectedPlayer }) => {
    const roomName = socket.roomName;
    const room = rooms[roomName];

    if (!room) {
      return socket.emit('errorMessage', 'Room not found.');
    }

    if (room.game.phase !== 'voting') {
      return socket.emit('errorMessage', 'Voting is not active right now.');
    }

    const player = room.players.find((roomPlayer) => roomPlayer.id === socket.id);
    if (!player) {
      return socket.emit('errorMessage', 'Player not found.');
    }

    if (!suspectedPlayer) {
      return socket.emit('errorMessage', 'Please select a player to vote for.');
    }

    if (suspectedPlayer === player.username) {
      return socket.emit('errorMessage', 'You cannot vote for yourself.');
    }

    const targetPlayer = room.players.find((roomPlayer) => roomPlayer.username === suspectedPlayer);
    if (!targetPlayer) {
      return socket.emit('errorMessage', 'Selected player is not in this room.');
    }

    player.vote = suspectedPlayer;
    maybeFinishVoting(room);
  });

  socket.on('disconnect', () => {
    if (socket.skipRoomCleanup) {
      return;
    }

    const roomName = socket.roomName;
    const clientId = socket.clientId;

    if (!roomName || !clientId || !rooms[roomName]) {
      return;
    }

    const room = rooms[roomName];
    const player = findPlayerByClientId(room, clientId);
    if (!player) {
      return;
    }

    player.connected = false;
    clearDisconnectTimer(player);
    player.disconnectTimer = setTimeout(() => {
      removePlayerFromRoom(roomName, clientId);
    }, PLAYER_DISCONNECT_GRACE_MS);

    emitRoomState(roomName);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
