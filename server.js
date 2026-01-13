// Minimal print server for local fallback (serial / RFCOMM / COM port)
// Ditambah: dukungan model metadata (contoh: SC03h-6081) -> urutan encoding best-effort
// Usage:
//   PORT=3000 PRINTER_PORT=/dev/rfcomm0 BAUD_RATE=9600 node server.js

const express = require('express');
const SerialPort = require('serialport');
const iconv = require('iconv-lite');

const app = express();
app.use(express.json({ limit: '5mb' }));

const LISTEN_PORT = process.env.PORT || 3000;
const PRINTER_PORT = process.env.PRINTER_PORT || process.env.PRINT_PORT || '/dev/rfcomm0';
const BAUD_RATE = parseInt(process.env.BAUD_RATE || '9600', 10);

let serial = null;
let opening = false;

async function ensureSerialOpen() {
  if (serial && serial.isOpen) return serial;
  if (opening) {
    for (let i = 0; i < 20; i++) {
      if (serial && serial.isOpen) return serial;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  opening = true;
  try {
    serial = new SerialPort(PRINTER_PORT, { baudRate: BAUD_RATE, autoOpen: false });
    await new Promise((resolve, reject) => {
      serial.open(err => err ? reject(err) : resolve());
    });
    serial.on('error', err => console.error('Serial error:', err));
    console.log(`Serial port opened: ${PRINTER_PORT} @ ${BAUD_RATE}`);
    return serial;
  } finally {
    opening = false;
  }
}

// Build buffer with chosen encoding and ESC/POS cut appended
function buildEscFromTextWithEncoding(text, encoding) {
  try {
    const encoded = iconv.encode(text + '\n\n\n', encoding, { defaultChar: '?' });
    // GS V 1 (partial cut)
    const cut = Buffer.from([0x1d, 0x56, 0x01]);
    return Buffer.concat([encoded, cut]);
  } catch (e) {
    return null;
  }
}

// server will try encoding order based on model; returns Buffer
function buildBestEffortBuffer(text, model, preferredEncoding = null) {
  // default order
  let order = ['cp1252', 'cp857', 'cp858', 'cp852', 'utf8'];
  if (model && model.toLowerCase().includes('sc03')) {
    // SC03h-6081 heuristic: try cp857 / cp858 first, then others
    order = ['cp857', 'cp858', 'cp1252', 'cp852', 'utf8'];
  }
  // if client provided preferredEncoding, try it first
  if (preferredEncoding && preferredEncoding !== 'auto') {
    order = [preferredEncoding, ...order.filter(o => o !== preferredEncoding)];
  }

  console.log(`buildBestEffortBuffer: model=${model}, order=${order.join(',')}`);

  for (const enc of order) {
    try {
      if (enc === 'utf8') {
        const buf = Buffer.from(text + '\n\n\n', 'utf8');
        console.log('Using encoding utf8');
        return Buffer.concat([buf, Buffer.from([0x1d,0x56,0x01])]);
      } else {
        console.log(`Attempt encoding: ${enc}`);
        const b = buildEscFromTextWithEncoding(text, enc);
        if (b) {
          console.log(`Encoding ${enc} succeeded`);
          return b;
        }
      }
    } catch (e) {
      console.warn(`Encoding ${enc} failed: ${e.message || e}`);
    }
  }
  console.warn('All encodings failed, falling back to utf8 buffer');
  return Buffer.from(text + '\n\n\n', 'utf8');
}

app.post('/print', async (req, res) => {
  try {
    const body = req.body || {};
    const model = body.model || '';
    const preferred = body.preferred_encoding || null;

    if (!body.escpos_base64 && !body.text) {
      return res.status(400).json({ ok: false, message: 'Missing escpos_base64 or text in body' });
    }

    let buf;
    if (body.escpos_base64) {
      try {
        buf = Buffer.from(body.escpos_base64, 'base64');
      } catch (e) {
        return res.status(400).json({ ok: false, message: 'Invalid base64' });
      }
    } else {
      // build best-effort buffer based on model and preferred encoding
      buf = buildBestEffortBuffer(body.text, model, preferred);
    }

    const port = await ensureSerialOpen();
    await new Promise((resolve, reject) => {
      port.write(buf, err => {
        if (err) return reject(err);
        port.drain(err2 => err2 ? reject(err2) : resolve());
      });
    });

    console.log(`Printed via ${PRINTER_PORT} (model=${model || 'unknown'}, preferred=${preferred || 'none'})`);
    return res.json({ ok: true, message: 'Sent to printer' });
  } catch (err) {
    console.error('Print error', err);
    return res.status(500).json({ ok: false, message: String(err) });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, printerPort: PRINTER_PORT }));

app.listen(LISTEN_PORT, () => {
  console.log(`Print server listening on http://localhost:${LISTEN_PORT}`);
  console.log(`Configured PRINTER_PORT=${PRINTER_PORT} BAUD_RATE=${BAUD_RATE}`);
});