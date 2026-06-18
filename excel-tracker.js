const ExcelJS = require('exceljs');
const path = require('path');

const EXCEL_FILE = path.join(__dirname, 'messages-log.xlsx');

function makeSessionName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const name = `${d.getDate()}-${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return name.slice(0, 31); // Excel sheet name limit
}

class ExcelSession {
  constructor() {
    this.wb = null;
    this.sheet = null;
    this.sessionName = null;
    this.rowCount = 0;
  }

  async init() {
    this.wb = new ExcelJS.Workbook();
    try {
      await this.wb.xlsx.readFile(EXCEL_FILE);
    } catch {
      // File doesn't exist yet — starts fresh
    }
  }

  // Returns a Set of normalized phone numbers previously sent to successfully
  async getPreviouslyContacted() {
    if (!this.wb) await this.init();
    const contacted = new Set();
    this.wb.eachSheet(ws => {
      ws.eachRow((row, rowNum) => {
        if (rowNum === 1) return; // skip header
        const number = String(row.getCell(2).value || '').trim();
        const status = String(row.getCell(3).value || '').trim();
        if (number && status === 'Sent') contacted.add(number);
      });
    });
    return contacted;
  }

  async startSession() {
    if (!this.wb) await this.init();

    let name = makeSessionName();
    // Ensure unique name if two sessions start in the same minute
    let suffix = 2;
    while (this.wb.getWorksheet(name)) {
      name = `${makeSessionName()} (${suffix++})`;
    }
    this.sessionName = name;
    this.rowCount = 0;

    this.sheet = this.wb.addWorksheet(name);
    this.sheet.columns = [
      { header: '#',            key: 'index',    width: 6  },
      { header: 'Phone Number', key: 'number',   width: 20 },
      { header: 'Status',       key: 'status',   width: 18 },
      { header: 'Platform',     key: 'platform', width: 14 },
      { header: 'Message',      key: 'message',  width: 50 },
      { header: 'Time',         key: 'time',     width: 22 },
    ];

    const header = this.sheet.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    header.alignment = { vertical: 'middle' };

    await this.wb.xlsx.writeFile(EXCEL_FILE);
    return name;
  }

  async logRow({ number, status, platform, message }) {
    if (!this.sheet) return;
    this.rowCount++;

    const row = this.sheet.addRow({
      index:    this.rowCount,
      number,
      status,
      platform: platform || '—',
      message:  message || '',
      time:     new Date().toLocaleString(),
    });

    // Color-code the status cell
    const cell = row.getCell('status');
    const colors = {
      'Sent':              'FFC6EFCE', // green
      'Skipped':           'FFFFEB9C', // yellow
      'Already contacted': 'FFDCE6F1', // blue
    };
    if (colors[status]) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors[status] } };
    }

    await this.wb.xlsx.writeFile(EXCEL_FILE);
  }
}

module.exports = { ExcelSession, EXCEL_FILE };
