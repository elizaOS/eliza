/**
 * Excerpt from bn.js - BigNumber library
 * https://github.com/indutny/bn.js
 *
 * This excerpt demonstrates common timing vulnerability patterns
 * in JavaScript cryptographic libraries.
 */

// Division operations - use hardware division which has variable timing
BN.prototype.div = function div(num) {
  return this.divmod(num, 'div', false).div;
};

BN.prototype.mod = function mod(num) {
  return this.divmod(num, 'mod', false).mod;
};

BN.prototype.umod = function umod(num) {
  return this.divmod(num, 'mod', true).mod;
};

// Comparison function - early-exit on sign differences leaks timing
BN.prototype.cmp = function cmp(num) {
  if (this.negative !== 0 && num.negative === 0) return -1;
  if (this.negative === 0 && num.negative !== 0) return 1;

  var res = this.ucmp(num);
  if (this.negative !== 0) return -res | 0;
  return res;
};

// Unsigned comparison - iterates until difference found (timing leak)
BN.prototype.ucmp = function ucmp(num) {
  if (this.length > num.length) return 1;
  if (this.length < num.length) return -1;

  var res = 0;
  for (var i = this.length - 1; i >= 0; i--) {
    var a = this.words[i] | 0;
    var b = num.words[i] | 0;
    if (a === b) continue;  // Early exit - timing leak!
    if (a < b) {
      res = -1;
    } else if (a > b) {
      res = 1;
    }
    break;
  }
  return res;
};

// Modular exponentiation - windowed method with data-dependent branches
Red.prototype.pow = function pow(a, num) {
  if (num.isZero()) return new BN(1).toRed(this);
  if (num.cmpn(1) === 0) return a.clone();

  var windowSize = 4;
  var wnd = new Array(1 << windowSize);
  wnd[0] = new BN(1).toRed(this);
  wnd[1] = a;
  for (var i = 2; i < wnd.length; i++) {
    wnd[i] = this.mul(wnd[i - 1], a);
  }

  var res = wnd[0];
  var current = 0;
  var currentLen = 0;
  var start = num.bitLength() % 26;
  if (start === 0) {
    start = 26;
  }

  for (i = num.length - 1; i >= 0; i--) {
    var word = num.words[i];
    for (var j = start - 1; j >= 0; j--) {
      var bit = (word >> j) & 1;
      if (res !== wnd[0]) {
        res = this.sqr(res);
      }
      // Data-dependent branch on secret exponent bit!
      if (bit === 0 && current === 0) {
        currentLen = 0;
        continue;
      }
      current <<= 1;
      current |= bit;
      currentLen++;
      if (currentLen !== windowSize && (i !== 0 || j !== 0)) continue;
      res = this.mul(res, wnd[current]);
      currentLen = 0;
      current = 0;
    }
    start = 26;
  }

  return res;
};

// Division with remainder - internally uses variable-time division
BN.prototype.divmod = function divmod(num, mode, positive) {
  if (num.isZero()) {
    throw new Error('division by zero');
  }

  if (this.isZero()) {
    return {
      div: new BN(0),
      mod: new BN(0)
    };
  }

  var div, mod, res;
  if (this.negative !== 0 && num.negative === 0) {
    res = this.neg().divmod(num, mode);
    if (mode !== 'mod') {
      div = res.div.neg();
    }
    if (mode !== 'div') {
      mod = res.mod.neg();
      if (positive && mod.negative !== 0) {
        mod.iadd(num);
      }
    }
    return { div: div, mod: mod };
  }

  // Uses division internally
  if (this.length > num.length || this.cmp(num) >= 0) {
    // Variable-time long division algorithm
    var shift = num.bitLength() - this.bitLength();
    // ... implementation uses / and % operators
  }

  return { div: div, mod: mod };
};

// Montgomery reduction - uses modular operations
Mont.prototype.mul = function mul(a, b) {
  if (a.isZero() || b.isZero()) return new BN(0)._forceRed(this);

  var t = a.mul(b);
  // Uses mod operation internally
  var c = t.maskn(this.shift).mul(this.minv).imaskn(this.shift).mul(this.m);
  var u = t.isub(c).iushrn(this.shift);
  var res = u;

  if (u.cmp(this.m) >= 0) {
    res = u.isub(this.m);
  } else if (u.cmpn(0) < 0) {
    res = u.iadd(this.m);
  }

  return res._forceRed(this);
};

// Modular inverse - uses extended Euclidean algorithm with data-dependent iterations
BN.prototype.invm = function invm(num) {
  return this.egcd(num).a.umod(num);
};

BN.prototype._invmp = function _invmp(p) {
  var a = this;
  var b = p.clone();

  if (a.negative !== 0) {
    a = a.umod(p);
  } else {
    a = a.clone();
  }

  var x1 = new BN(1);
  var x2 = new BN(0);

  // Iterations depend on input values - timing leak
  while (a.cmpn(1) > 0 && b.cmpn(1) > 0) {
    // ... iteration count reveals information about inputs
  }

  return res;
};

// Test function to prevent dead code elimination
function runBnOperations() {
  var a = new BN('deadbeef', 16);
  var b = new BN('cafebabe', 16);

  // These operations have timing leaks
  var divResult = a.div(b);
  var modResult = a.mod(b);
  var cmpResult = a.cmp(b);

  console.log('Division:', divResult.toString(16));
  console.log('Modulo:', modResult.toString(16));
  console.log('Comparison:', cmpResult);
}

// Stub for BN constructor
function BN(number, base) {
  this.words = [];
  this.length = 0;
  this.negative = 0;
}

function Red() {}
function Mont() {}
