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
    offers: {},         // { seatLabel: { buy, sell } }
    trades: [],         // [{ buyer, seller, price, time }]
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
        
        io.to(roomId).emit('roundAdvance', {
          currentRound: room.currentRound,
          revealedDigits: room.digits.slice(0, room.currentRound - 1)
        });

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

    socket.emit('initPlayer', {
      seat: userSeat,
      roomId: roomId,
      revealedDigits: room.digits.slice(0, room.currentRound - 1),
      currentRound: room.currentRound,
      timeLeft: room.timeLeft
    });

    io.to(roomId).emit('stateUpdate', getRoomState(room));

    const activePlayerCount = Object.values(room.seats).filter(Boolean).length;
    if (activePlayerCount >= 2 && !room.timerInterval) {
      startRoomTimer(roomId);
    }
  });

  // Player posts an Offer/Quote (Buy & Sell prices)
  socket.on('postOffer', ({ buy, sell }) => {
    if (!currentRoomId || !userSeat) return;
    const room = rooms[currentRoomId];
    
    const buyVal = parseInt(buy) || null;
    const sellVal = parseInt(sell) || null;

    if (buyVal && sellVal && buyVal >= sellVal) {
      socket.emit('errorMsg', 'Invalid Quote! BUY price must be lower than SELL price.');
      return;
    }

    // Save individual player market quotes persistent across state
    room.offers[userSeat] = { buy: buyVal, sell: sellVal };
    
    // Auto-match if buy order crosses an existing sell order from someone else
    checkOrderMatches(room);

    io.to(currentRoomId).emit('stateUpdate', getRoomState(room));
  });

  // Direct Table-Click Executions
  socket.on('executeDirectTrade', ({ targetSeat, action }) => {
    if (!currentRoomId || !userSeat || userSeat === targetSeat) return;
    const room = rooms[currentRoomId];
    const targetOffer = room.offers[targetSeat];

    if (!targetOffer) return;

    // Check position limits (+-2)
    if (action === 'BUY' && room.positions[userSeat] >= 2) {
      socket.emit('errorMsg', 'Position limit (+2) reached!');
      return;
    }
    if (action === 'SELL' && room.positions[userSeat] <= -2) {
      socket.emit('errorMsg', 'Position limit (-2) reached!');
      return;
    }
    if (action === 'BUY' && room.positions[targetSeat] <= -2) {
      socket.emit('errorMsg', `Target Player (${targetSeat}) has hit short position limit!`);
      return;
    }
    if (action === 'SELL' && room.positions[targetSeat] >= 2) {
      socket.emit('errorMsg', `Target Player (${targetSeat}) has hit long position limit!`);
      return;
    }

    let tradePrice = 0;

    if (action === 'BUY') {
      // You buy from targetSeat at targetSeat's SELL price
      if (!targetOffer.sell) return;
      tradePrice = targetOffer.sell;

      room.positions[userSeat] += 1;
      room.pnls[userSeat] -= tradePrice;
      room.positions[targetSeat] -= 1;
      room.pnls[targetSeat] += tradePrice;

      room.trades.push({
        buyer: userSeat,
        seller: targetSeat,
        price: tradePrice,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      });
    } else if (action === 'SELL') {
      // You sell to targetSeat at targetSeat's BUY price
      if (!targetOffer.buy) return;
      tradePrice = targetOffer.buy;

      room.positions[userSeat] -= 1;
      room.pnls[userSeat] += tradePrice;
      room.positions[targetSeat] += 1;
      room.pnls[targetSeat] -= tradePrice;

      room.trades.push({
        buyer: targetSeat,
        seller: userSeat,
        price: tradePrice,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      });
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
  for (const seatA of Object.keys(room.offers)) {
    for (const seatB of Object.keys(room.offers)) {
      if (seatA === seatB) continue;
      const offerA = room.offers[seatA];
      const offerB = room.offers[seatB];

      // If Seat A's BUY price crosses or equals Seat B's SELL price
      if (offerA && offerB && offerA.buy && offerB.sell && offerA.buy >= offerB.sell) {
        const matchPrice = offerB.sell;

        room.positions[seatA] += 1;
        room.pnls[seatA] -= matchPrice;
        room.positions[seatB] -= 1;
        room.pnls[seatB] += matchPrice;

        room.trades.push({
          buyer: seatA,
          seller: seatB,
          price: matchPrice,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });

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