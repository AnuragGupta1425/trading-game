const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// Store room states
const rooms = {};

// Helper: Generate round digit and full value
function generateRoundData(roundNumber) {
  const digit = Math.floor(Math.random() * 10);
  return { round: roundNumber, digit };
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Join or create room
  socket.on('joinRoom', ({ roomId, playerName }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        roomId,
        players: {},
        seats: { A: null, B: null, C: null, D: null, E: null, F: null },
        round: 1,
        maxRounds: 6,
        timer: 90,
        timerInterval: null,
        digits: [],
        orders: [], // Array of { id, playerId, name, type: 'BUY'|'SELL', price, qty }
        trades: [],
        gameStarted: false
      };
    }

    const room = rooms[roomId];

    // Assign seat (A to F)
    const availableSeats = ['A', 'B', 'C', 'D', 'E', 'F'].filter(s => !room.seats[s]);
    if (availableSeats.length === 0 && !room.players[socket.id]) {
      socket.emit('errorMsg', 'Room is full (Max 6 players).');
      return;
    }

    let assignedSeat = null;
    if (!room.players[socket.id]) {
      assignedSeat = availableSeats[0];
      room.seats[assignedSeat] = socket.id;
      room.players[socket.id] = {
        id: socket.id,
        name: playerName || `Player ${assignedSeat}`,
        seat: assignedSeat,
        position: 0,
        pnl: 0,
        cash: 10000
      };
    }

    // Auto-start timer if 2 or more players join and game isn't started
    if (Object.keys(room.players).length >= 1 && !room.gameStarted) {
      room.gameStarted = true;
      startRoundTimer(roomId);
    }

    io.to(roomId).emit('roomState', getSanitizedRoomState(room));
  });

  // Place Buy/Sell Order
  socket.on('placeOrder', ({ roomId, type, price, qty }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;

    const numPrice = parseFloat(price);
    const numQty = parseInt(qty, 10);

    if (isNaN(numPrice) || isNaN(numQty) || numQty <= 0) return;

    const newOrder = {
      id: Date.now() + Math.random().toString(36).substr(2, 4),
      playerId: socket.id,
      playerName: player.name,
      seat: player.seat,
      type: type.toUpperCase(), // 'BUY' or 'SELL'
      price: numPrice,
      qty: numQty
    };

    room.orders.push(newOrder);
    io.to(roomId).emit('roomState', getSanitizedRoomState(room));
  });

  // Click on order table offer to execute trade
  socket.on('takeOrder', ({ roomId, orderId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const taker = room.players[socket.id];
    if (!taker) return;

    const orderIndex = room.orders.findIndex(o => o.id === orderId);
    if (orderIndex === -1) return;

    const order = room.orders[orderIndex];
    if (order.playerId === socket.id) {
      socket.emit('errorMsg', 'You cannot trade against your own order!');
      return;
    }

    const maker = room.players[order.playerId];
    const tradeQty = order.qty;
    const tradePrice = order.price;

    // Adjust positions & cash
    if (order.type === 'SELL') {
      // Taker is BUYING from Maker who is SELLING
      taker.position += tradeQty;
      maker.position -= tradeQty;
    } else {
      // Taker is SELLING to Maker who is BUYING
      taker.position -= tradeQty;
      maker.position += tradeQty;
    }

    // Record trade
    const tradeRecord = {
      id: Date.now(),
      buyer: order.type === 'SELL' ? taker.name : maker.name,
      seller: order.type === 'SELL' ? maker.name : taker.name,
      price: tradePrice,
      qty: tradeQty,
      time: new Date().toLocaleTimeString()
    };

    room.trades.unshift(tradeRecord);
    
    // Remove executed order
    room.orders.splice(orderIndex, 1);

    io.to(roomId).emit('roomState', getSanitizedRoomState(room));
    io.to(roomId).emit('tradeExecuted', tradeRecord);
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.players[socket.id]) {
        const seat = room.players[socket.id].seat;
        room.seats[seat] = null;
        delete room.players[socket.id];
        
        // Remove active orders by this player
        room.orders = room.orders.filter(o => o.playerId !== socket.id);

        if (Object.keys(room.players).length === 0) {
          clearInterval(room.timerInterval);
          delete rooms[roomId];
        } else {
          io.to(roomId).emit('roomState', getSanitizedRoomState(room));
        }
        break;
      }
    }
  });
});

function startRoundTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Reveal new digit for current round if not already generated
  if (room.digits.length < room.round) {
    room.digits.push(generateRoundData(room.round));
  }

  if (room.timerInterval) clearInterval(room.timerInterval);

  room.timer = 90;

  room.timerInterval = setInterval(() => {
    room.timer--;

    if (room.timer <= 0) {
      if (room.round < room.maxRounds) {
        room.round++;
        room.digits.push(generateRoundData(room.round));
        room.timer = 90;
        io.to(roomId).emit('roundAdvance', { round: room.round, digits: room.digits });
      } else {
        clearInterval(room.timerInterval);
        room.gameStarted = false;
      }
    }

    io.to(roomId).emit('timerUpdate', { timer: room.timer, round: room.round });
  }, 1000);
}

function getSanitizedRoomState(room) {
  return {
    roomId: room.roomId,
    players: room.players,
    seats: room.seats,
    round: room.round,
    maxRounds: room.maxRounds,
    timer: room.timer,
    digits: room.digits,
    orders: room.orders,
    trades: room.trades
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));