const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const EXCEL_FILE = path.join(__dirname, 'messages-log.xlsx');

function makeSessionName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getDate()}-${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`.slice(0, 31);
}

class ExcelSession {
  constructor() {
    this.wb = null;
    this.sheet = null;
    this.sessionName = null;
    this.rowCount = 0;
    this._writeChain = Promise.resolve(); // all writes queued here, never awaited by caller
  }

  // Queue a write without blocking the caller
  _save() {
    this._writeChain = this._writeChain.then(() =>
      this.wb.xlsx.writeFile(EXCEL_FILE).catch(err =>
        console.error('Excel write error (non-fatal):', err.message)
      )
    );
  }

  async init() {
    this.wb = new ExcelJS.Workbook();
    if (!fs.existsSync(EXCEL_FILE)) return; // no history yet
    try {
      await this.wb.xlsx.readFile(EXCEL_FILE);
    } catch {
      // corrupt or locked — start fresh
    }
  }

  // Returns Set of phone numbers we've previously sent to successfully
  getPreviouslyContacted() {
    const contacted = new Set();
    if (!this.wb) return contacted;
    this.wb.eachSheet(ws => {
      ws.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const number = String(row.getCell(3).value || '').trim();
        const status = String(row.getCell(4).value || '').trim();
        if (number && status === 'Sent') contacted.add(number);
      });
    });
    return contacted; // sync — no await needed
  }

  startSession() {
    let name = makeSessionName();
    let suffix = 2;
    while (this.wb.getWorksheet(name)) name = `${makeSessionName()} (${suffix++})`;
    this.sessionName = name;
    this.rowCount = 0;

    this.sheet = this.wb.addWorksheet(name);
    this.sheet.columns = [
      { header: '#',             key: 'index',    width: 6  },
      { header: 'Business Name', key: 'name',     width: 28 },
      { header: 'Phone Number',  key: 'number',   width: 20 },
      { header: 'Status',        key: 'status',   width: 18 },
      { header: 'Platform',      key: 'platform', width: 14 },
      { header: 'Message',       key: 'message',  width: 50 },
      { header: 'Time',          key: 'time',     width: 22 },
    ];

    const header = this.sheet.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    header.alignment = { vertical: 'middle' };

    this._save(); // write in background, don't block
    return name;
  }

  logRow({ name, number, status, platform, message }) {
    if (!this.sheet) return;
    this.rowCount++;

    const row = this.sheet.addRow({
      index:    this.rowCount,
      name:     name || '',
      number,
      status,
      platform: platform || '—',
      message:  message || '',
      time:     new Date().toLocaleString(),
    });

    const colors = {
      'Sent':              'FFC6EFCE',
      'Skipped':           'FFFFEB9C',
      'Already contacted': 'FFDCE6F1',
    };
    const cell = row.getCell('status');
    if (colors[status]) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors[status] } };
    }

    this._save(); // write in background, don't block
  }
}

module.exports = { ExcelSession, EXCEL_FILE };
