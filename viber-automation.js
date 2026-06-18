const puppeteer = require('puppeteer');

class ViberBot {
  constructor({ onQR, onReady, onLog, onDisconnected }) {
    this.browser = null;
    this.page = null;
    this.ready = false;
    this.onQR = onQR;
    this.onReady = onReady;
    this.onLog = onLog || (() => {});
    this.onDisconnected = onDisconnected || (() => {});
    this._qrInterval = null;
    this._readyInterval = null;
  }

  async init() {
    const isCloud = !!process.env.PORT;
    this.browser = await puppeteer.launch({
      headless: isCloud ? 'new' : false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1100,750',
      ],
      defaultViewport: { width: 1100, height: 750 },
    });

    this.page = await this.browser.newPage();
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    this.browser.on('disconnected', () => {
      this.ready = false;
      this.onDisconnected();
    });

    await this.page.goto('https://web.viber.com', { waitUntil: 'networkidle2', timeout: 30000 });
    this._pollForQRAndLogin();
  }

  _pollForQRAndLogin() {
    let qrSent = false;

    this._qrInterval = setInterval(async () => {
      if (!this.page || this.ready) return;

      try {
        // Check if already logged in (chat list visible)
        const loggedIn = await this.page.evaluate(() => {
          const selectors = [
            '[data-qa="conversation-list"]',
            '[class*="ConversationList"]',
            '[class*="chat-list"]',
            '[class*="sidebar"]',
            '.conversations-list',
          ];
          return selectors.some(s => document.querySelector(s) !== null);
        });

        if (loggedIn) {
          clearInterval(this._qrInterval);
          this.ready = true;
          this.onReady();
          return;
        }

        // Take screenshot of QR area and send it
        const screenshot = await this.page.screenshot({ encoding: 'base64', fullPage: false });
        this.onQR('data:image/png;base64,' + screenshot);
        qrSent = true;
      } catch (e) {
        // page may be navigating
      }
    }, 2500);
  }

  // Returns true if sent, false if number not on Viber
  async sendMessage(rawNumber, message) {
    if (!this.ready || !this.page) throw new Error('Viber not connected');

    const number = normalizeNumber(rawNumber);
    this.onLog(`Viber: checking ${number}...`);

    try {
      // Click new conversation / compose button
      const composeClicked = await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const compose = btns.find(el => {
          const text = (el.textContent || '').toLowerCase();
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          return text.includes('new') || label.includes('new') || label.includes('compose')
            || title.includes('new') || title.includes('compose')
            || el.querySelector('svg') !== null; // icon buttons
        });
        if (compose) { compose.click(); return true; }
        return false;
      });

      if (!composeClicked) {
        // Try finding pencil/edit icon — look for specific Viber class patterns
        await this.page.evaluate(() => {
          const icons = document.querySelectorAll('[class*="compose"], [class*="new-chat"], [class*="newChat"]');
          if (icons.length) icons[0].click();
        });
      }

      await this._wait(1000);

      // Type phone number in search
      const searchInput = await this.page.evaluate((num) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'));
        const input = inputs.find(el => {
          const ph = (el.placeholder || '').toLowerCase();
          return ph.includes('search') || ph.includes('name') || ph.includes('number') || ph.includes('find') || ph === '';
        }) || inputs[0];
        if (input) {
          input.focus();
          input.value = num;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
          return true;
        }
        return false;
      }, number);

      if (!searchInput) {
        this.onLog(`Viber: could not find search input for ${number}`);
        return false;
      }

      await this._wait(2000);

      // Check if a contact result appeared (not an "invite" link)
      const contactFound = await this.page.evaluate((num) => {
        const items = Array.from(document.querySelectorAll('[class*="result"], [class*="contact"], [class*="user"], li, [role="option"], [role="listitem"]'));
        // Look for items that contain the number or a name (not just "invite")
        return items.some(el => {
          const text = (el.textContent || '').toLowerCase();
          return !text.includes('invite') && (text.includes(num.slice(-6)) || text.match(/\+?\d{6,}/));
        });
      }, number);

      if (!contactFound) {
        this.onLog(`Viber: ${number} is not on Viber`);
        // Close/cancel the compose dialog
        await this.page.keyboard.press('Escape');
        return false;
      }

      // Click the first valid contact result
      await this.page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[class*="result"], [class*="contact"], [class*="user"], li, [role="option"]'));
        const valid = items.find(el => {
          const text = (el.textContent || '').toLowerCase();
          return !text.includes('invite');
        });
        if (valid) valid.click();
      });

      await this._wait(1500);

      // Type and send message
      const sent = await this.page.evaluate((msg) => {
        const inputs = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]'));
        const msgBox = inputs.find(el => {
          const ph = (el.getAttribute('placeholder') || '').toLowerCase();
          return ph.includes('message') || ph.includes('type') || ph === '';
        }) || inputs[inputs.length - 1];
        if (msgBox) {
          msgBox.focus();
          if (msgBox.tagName === 'TEXTAREA' || msgBox.tagName === 'INPUT') {
            msgBox.value = msg;
            msgBox.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            document.execCommand('insertText', false, msg);
          }
          return true;
        }
        return false;
      }, message);

      if (!sent) {
        this.onLog(`Viber: could not find message input for ${number}`);
        return false;
      }

      await this._wait(500);
      await this.page.keyboard.press('Enter');
      await this._wait(500);

      this.onLog(`Viber: sent to ${number}`);
      return true;
    } catch (err) {
      this.onLog(`Viber error for ${number}: ${err.message}`);
      return false;
    }
  }

  async getScreenshot() {
    if (!this.page) return null;
    try {
      return 'data:image/png;base64,' + await this.page.screenshot({ encoding: 'base64' });
    } catch {
      return null;
    }
  }

  async close() {
    clearInterval(this._qrInterval);
    if (this.browser) await this.browser.close();
    this.ready = false;
    this.browser = null;
    this.page = null;
  }

  _wait(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

function normalizeNumber(raw) {
  // Strip everything except digits and leading +
  let n = raw.replace(/[^\d+]/g, '');
  if (!n.startsWith('+')) n = '+' + n;
  return n;
}

module.exports = { ViberBot, normalizeNumber };
