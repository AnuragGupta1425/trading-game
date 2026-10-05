const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory Room Storage
const rooms = {};

function createRoom(roomId) {
  const digits = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10));
  const trueSum = digits.reduce((a, b) => a + b, 0);

  return {
    id: roomId,
    digits: digits,
    trueSum: trueSum,
    currentRound: 1,
    timeLeft: 90,
    timerInterval: null,
    seats: { A: null, B: null, C: null, D: null, E: null, F: null },
    offers: {},          // { seatLabel: { bid, ask } }
    workingOrders: [],  // [{ id, seat, action, price, socketId }]
    trades: [],         // [{ buyer, seller, price }]
    pnls: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 },
    positions: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 }
  };
}

function startRoomTimer(roomId) {
  const room = rooms[roomId];
  if (!room || room.timerInterval) return;

  room.timerInterval = setInterval(() => {
    if (room.timeLeft > 0) {
      room.timeLeft--;
      io.to(roomId).emit('timerUpdate', room.timeLeft);
    } else {
      if (room.currentRound < 6) {
        room.currentRound++;
        room.timeLeft = 90;
        
        // Emit round advance event
        io.to(roomId).emit('roundAdvance', {
          currentRound: room.currentRound,
          revealedDigits: room.digits.slice(0, room.currentRound - 1)
        });

        // FIXED: Broadcast updated room state so all clients sync to the new round
        io.to(roomId).emit('stateUpdate', getRoomState(room));
      } else {
        clearInterval(room.timerInterval);
        room.timerInterval = null;
        io.to(roomId).emit('gameOver', {
          digits: room.digits,
          trueSum: room.trueSum,
          pnls: room.pnls,
          positions: room.positions
        });
      }
    }
  }, 1000);
}

io.on('connection', (socket) => {
  let currentRoomId = null;
  let userSeat = null;

  // Create or Join Room
  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = createRoom(roomId);
    }
    const room = rooms[roomId];

    // Assign seat
    const seatKeys = ['A', 'B', 'C', 'D', 'E', 'F'];
    const availableSeat = seatKeys.find(s => !room.seats[s]);

    if (!availableSeat) {
      socket.emit('errorMsg', 'Room is full! Maximum 6 players allowed.');
      return;
    }

    userSeat = availableSeat;
    currentRoomId = roomId;
    room.seats[userSeat] = { socketId: socket.id, name: playerName };
    socket.join(roomId);

    // Notify user of assigned seat
    socket.emit('initPlayer', {
      seat: userSeat,
      roomId: roomId,
      revealedDigits: room.digits.slice(0, room.currentRound - 1),
      currentRound: room.currentRound,
      timeLeft: room.timeLeft
    });

    // Broadcast updated state to room
    io.to(roomId).emit('stateUpdate', getRoomState(room));

    // Auto-start timer if at least 2 players joined
    const activePlayerCount = Object.values(room.seats).filter(Boolean).length;
    if (activePlayerCount >= 2 && !room.timerInterval) {
      startRoomTimer(roomId);
    }
  });

  // Player posts an Offer/Quote (Bid & Ask) or Limit Order
  socket.on('postOffer', ({ bid, ask }) => {
    if (!currentRoomId || !userSeat) return;
    const room = rooms[currentRoomId];
    
    room.offers[userSeat] = { bid: parseInt(bid), ask: parseInt(ask) };
    
    // Check auto-crosses against existing working orders
    checkOrderMatches(room);

    io.to(currentRoomId).emit('stateUpdate', getRoomState(room));
  });

  // Direct Click Executions (Clicking another player's green/red badge)
  socket.on('executeDirectTrade', ({ targetSeat, action, price }) => {
    if (!currentRoomId || !userSeat || userSeat === targetSeat) return;
    const room = rooms[currentRoomId];

    // Position limit verification (+-2)
    if (action === 'Buy' && room.positions[userSeat] >= 2) {
      socket.emit('errorMsg', 'Position limit (+2) reached!');
      return;
    }
    if (action === 'Sell' && room.positions[userSeat] <= -2) {
      socket.emit('errorMsg', 'Position limit (-2) reached!');
      return;
    }

    const tradePrice = parseInt(price);

    if (action === 'Buy') {
      room.positions[userSeat] += 1;
      room.pnls[userSeat] -= tradePrice;
      room.positions[targetSeat] -= 1;
      room.pnls[targetSeat] += tradePrice;
      room.trades.push({ buyer: userSeat, seller: targetSeat, price: tradePrice });
    } else {
      room.positions[userSeat] -= 1;
      room.pnls[userSeat] += tradePrice;
      room.positions[targetSeat] += 1;
      room.pnls[targetSeat] -= tradePrice;
      room.trades.push({ buyer: targetSeat, seller: userSeat, price: tradePrice });
    }

    io.to(currentRoomId).emit('stateUpdate', getRoomState(room));
  });

  // Handle Disconnects
  socket.on('disconnect', () => {
    if (currentRoomId && userSeat && rooms[currentRoomId]) {
      const room = rooms[currentRoomId];
      room.seats[userSeat] = null;
      delete room.offers[userSeat];
      io.to(currentRoomId).emit('stateUpdate', getRoomState(room));
    }
  });
});

function checkOrderMatches(room) {
  // Simple order matching loop across active offers
  for (const seatA of Object.keys(room.offers)) {
    for (const seatB of Object.keys(room.offers)) {
      if (seatA === seatB) continue;
      const offerA = room.offers[seatA];
      const offerB = room.offers[seatB];

      if (offerA && offerB && offerA.bid >= offerB.ask && offerB.ask > 0) {
        const matchPrice = offerB.ask;
        // Execute trade
        room.positions[seatA] += 1;
        room.pnls[seatA] -= matchPrice;
        room.positions[seatB] -= 1;
        room.pnls[seatB] += matchPrice;

        room.trades.push({ buyer: seatA, seller: seatB, price: matchPrice });
        delete room.offers[seatA];
        delete room.offers[seatB];
      }
    }
  }
}

function getRoomState(room) {
  return {
    seats: room.seats,
    offers: room.offers,
    trades: room.trades,
    pnls: room.pnls,
    positions: room.positions,
    currentRound: room.currentRound,
    revealedDigits: room.digits.slice(0, room.currentRound - 1)
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});