const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const homeSource = fs.readFileSync(path.join(root, 'website/home.js'), 'utf8');

test('homepage continue stores the return preference and opens sign-in', () => {
  assert.match(homeSource, /signInWithOAuth/);
  assert.match(homeSource, /signInWithOtp/);
  assert.doesNotMatch(homeSource, /signInWithWeb3|\/app\/|valhalla-entry-email/);
});

test('blocked storage does not pretend the entrance completed sign-in', () => {
  assert.match(homeSource, /providerMessage/);
  assert.doesNotMatch(homeSource, /sessionStorage|localStorage/);
});

test('entrance and volOS copy stay honest', () => {
  const home = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const volos = fs.readFileSync(path.join(root, 'website/volos/index.html'), 'utf8');
  assert.match(home, /Continue with Google/);
  assert.match(home, /Email me a sign-in link/);
  assert.match(home, /\/assets\/heaven-poster\.jpg/);
  assert.match(home, /Live trading is off/);
  assert.doesNotMatch(home, /Trade Solana|Public desk|github\.com/);
  const desk = fs.readFileSync(path.join(root, 'website/os/index.html'), 'utf8');
  for (const text of [home, volos, desk]) {
    assert.doesNotMatch(text, /enterWorkstationSession|keene\.jos|operator-01@|Valhalla2033|pk_test_/);
  }
  assert.match(desk, /data-open="wallet"/);
  assert.match(desk, /LIVE TRADING OFF/);
  assert.match(desk, /Feed not connected/);
  assert.match(home, /visual\.css/);
  assert.match(volos, /visual\.css/);
  assert.match(desk, /visual\.css/);
  assert.match(home, /loading="lazy"/);
  assert.match(desk, /disabled/);
  assert.match(desk, /id="desktop" hidden/);
  assert.match(desk, /id="sign-out"/);
  assert.match(desk, /id="account-level">Free/);
  assert.doesNotMatch(desk, /data-enter-desk|PUBLIC DESK|href="\/app\/"/);
  const mobile = fs.readFileSync(path.join(root, 'website/os/os.css'), 'utf8').split('@media (max-width: 720px)')[1];
  assert.doesNotMatch(mobile, /top:\s*118px/);
  assert.doesNotMatch(mobile, /z-index:\s*\d+\s*!important/);
  assert.match(mobile, /\.menu-bar,\s*\.dock\s*\{\s*z-index:\s*1/);
  assert.match(volos, /AwRR84BRbzPKSvWnw4BBNYmFYmRdRTBkLxCiKzTvpump/);
  assert.match(volos, /Not financial advice\. Holding the coin is not a promise of profit, yield, or a payout\./);
  assert.match(volos, /can fall to zero/);
  assert.match(volos, /https:\/\/valhalla-app\.xyz\//);
  assert.match(volos, /https:\/\/pump\.fun\/coin\/AwRR84BRbzPKSvWnw4BBNYmFYmRdRTBkLxCiKzTvpump/);
  assert.doesNotMatch(volos, /Not published/);
  assert.doesNotMatch(volos, /will pump/i);
  assert.doesNotMatch(volos, /github\.com/i);
  assert.doesNotMatch(volos, /0x[0-9a-fA-F]{40}/);
});
