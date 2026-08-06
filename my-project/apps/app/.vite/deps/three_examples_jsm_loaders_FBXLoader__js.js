import { $r as MathUtils, B as Bone, Bi as NumberKeyframeTrack, Bs as Vector3, Cs as Uint16BufferAttribute, Er as Line, Fo as Skeleton, Hs as VectorKeyframeTrack, J as BufferGeometry, Lo as SkinnedMesh, No as ShapeUtils, Nt as Curve, Or as LineBasicMaterial, Rn as Group, To as SRGBColorSpace, Ur as Loader, Vi as Object3D, Vs as Vector4, Wo as SpotLight, Wr as LoaderUtils, Zt as DirectionalLight, _a as Quaternion, _o as RepeatWrapping, at as ClampToEdgeWrapping, b as AnimationClip, bn as Float32BufferAttribute, ci as MeshLambertMaterial, di as MeshPhongMaterial, ds as TextureLoader, ii as Mesh, lt as ColorManagement, mn as Euler, na as PerspectiveCamera, ni as Matrix4, oa as PointLight, pa as PropertyBinding, st as Color, ti as Matrix3, us as Texture, v as AmbientLight, va as QuaternionKeyframeTrack, vn as FileLoader, zs as Vector2 } from "./three.module-DGMucbGR.js";
//#region ../../node_modules/three/examples/jsm/libs/fflate.module.js
/*!
fflate - fast JavaScript compression/decompression
<https://101arrowz.github.io/fflate>
Licensed under MIT. https://github.com/101arrowz/fflate/blob/master/LICENSE
version 0.8.2
*/
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	1,
	1,
	1,
	1,
	2,
	2,
	2,
	2,
	3,
	3,
	3,
	3,
	4,
	4,
	4,
	4,
	5,
	5,
	5,
	5,
	0,
	0,
	0,
	0
]);
var fdeb = new u8([
	0,
	0,
	0,
	0,
	1,
	1,
	2,
	2,
	3,
	3,
	4,
	4,
	5,
	5,
	6,
	6,
	7,
	7,
	8,
	8,
	9,
	9,
	10,
	10,
	11,
	11,
	12,
	12,
	13,
	13,
	0,
	0
]);
var clim = new u8([
	16,
	17,
	18,
	0,
	8,
	7,
	9,
	6,
	10,
	5,
	11,
	4,
	12,
	3,
	13,
	2,
	14,
	1,
	15
]);
var freb = function(eb, start) {
	var b = new u16(31);
	for (var i = 0; i < 31; ++i) b[i] = start += 1 << eb[i - 1];
	var r = new i32(b[30]);
	for (var i = 1; i < 30; ++i) for (var j = b[i]; j < b[i + 1]; ++j) r[j] = j - b[i] << 5 | i;
	return {
		b,
		r
	};
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
_b.r;
var rev = new u16(32768);
for (var i = 0; i < 32768; ++i) {
	var x = (i & 43690) >> 1 | (i & 21845) << 1;
	x = (x & 52428) >> 2 | (x & 13107) << 2;
	x = (x & 61680) >> 4 | (x & 3855) << 4;
	rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var hMap = (function(cd, mb, r) {
	var s = cd.length;
	var i = 0;
	var l = new u16(mb);
	for (; i < s; ++i) if (cd[i]) ++l[cd[i] - 1];
	var le = new u16(mb);
	for (i = 1; i < mb; ++i) le[i] = le[i - 1] + l[i - 1] << 1;
	var co;
	if (r) {
		co = new u16(1 << mb);
		var rvb = 15 - mb;
		for (i = 0; i < s; ++i) if (cd[i]) {
			var sv = i << 4 | cd[i];
			var r_1 = mb - cd[i];
			var v = le[cd[i] - 1]++ << r_1;
			for (var m = v | (1 << r_1) - 1; v <= m; ++v) co[rev[v] >> rvb] = sv;
		}
	} else {
		co = new u16(s);
		for (i = 0; i < s; ++i) if (cd[i]) co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
	}
	return co;
});
var flt = new u8(288);
for (var i = 0; i < 144; ++i) flt[i] = 8;
for (var i = 144; i < 256; ++i) flt[i] = 9;
for (var i = 256; i < 280; ++i) flt[i] = 7;
for (var i = 280; i < 288; ++i) flt[i] = 8;
var fdt = new u8(32);
for (var i = 0; i < 32; ++i) fdt[i] = 5;
var flrm = /*#__PURE__*/ hMap(flt, 9, 1);
var fdrm = /*#__PURE__*/ hMap(fdt, 5, 1);
var max = function(a) {
	var m = a[0];
	for (var i = 1; i < a.length; ++i) if (a[i] > m) m = a[i];
	return m;
};
var bits = function(d, p, m) {
	var o = p / 8 | 0;
	return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
	var o = p / 8 | 0;
	return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
	return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
	if (s == null || s < 0) s = 0;
	if (e == null || e > v.length) e = v.length;
	return new u8(v.subarray(s, e));
};
var ec = [
	"unexpected EOF",
	"invalid block type",
	"invalid length/literal",
	"invalid distance",
	"stream finished",
	"no stream handler",
	,
	"no callback",
	"invalid UTF-8 data",
	"extra field too long",
	"date not in range 1980-2099",
	"filename too long",
	"stream finishing",
	"invalid zip data"
];
var err = function(ind, msg, nt) {
	var e = new Error(msg || ec[ind]);
	e.code = ind;
	if (Error.captureStackTrace) Error.captureStackTrace(e, err);
	if (!nt) throw e;
	return e;
};
var inflt = function(dat, st, buf, dict) {
	var sl = dat.length, dl = dict ? dict.length : 0;
	if (!sl || st.f && !st.l) return buf || new u8(0);
	var noBuf = !buf;
	var resize = noBuf || st.i != 2;
	var noSt = st.i;
	if (noBuf) buf = new u8(sl * 3);
	var cbuf = function(l) {
		var bl = buf.length;
		if (l > bl) {
			var nbuf = new u8(Math.max(bl * 2, l));
			nbuf.set(buf);
			buf = nbuf;
		}
	};
	var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
	var tbts = sl * 8;
	do {
		if (!lm) {
			final = bits(dat, pos, 1);
			var type = bits(dat, pos + 1, 3);
			pos += 3;
			if (!type) {
				var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
				if (t > sl) {
					if (noSt) err(0);
					break;
				}
				if (resize) cbuf(bt + l);
				buf.set(dat.subarray(s, t), bt);
				st.b = bt += l, st.p = pos = t * 8, st.f = final;
				continue;
			} else if (type == 1) lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
			else if (type == 2) {
				var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
				var tl = hLit + bits(dat, pos + 5, 31) + 1;
				pos += 14;
				var ldt = new u8(tl);
				var clt = new u8(19);
				for (var i = 0; i < hcLen; ++i) clt[clim[i]] = bits(dat, pos + i * 3, 7);
				pos += hcLen * 3;
				var clb = max(clt), clbmsk = (1 << clb) - 1;
				var clm = hMap(clt, clb, 1);
				for (var i = 0; i < tl;) {
					var r = clm[bits(dat, pos, clbmsk)];
					pos += r & 15;
					var s = r >> 4;
					if (s < 16) ldt[i++] = s;
					else {
						var c = 0, n = 0;
						if (s == 16) n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
						else if (s == 17) n = 3 + bits(dat, pos, 7), pos += 3;
						else if (s == 18) n = 11 + bits(dat, pos, 127), pos += 7;
						while (n--) ldt[i++] = c;
					}
				}
				var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
				lbt = max(lt);
				dbt = max(dt);
				lm = hMap(lt, lbt, 1);
				dm = hMap(dt, dbt, 1);
			} else err(1);
			if (pos > tbts) {
				if (noSt) err(0);
				break;
			}
		}
		if (resize) cbuf(bt + 131072);
		var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
		var lpos = pos;
		for (;; lpos = pos) {
			var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
			pos += c & 15;
			if (pos > tbts) {
				if (noSt) err(0);
				break;
			}
			if (!c) err(2);
			if (sym < 256) buf[bt++] = sym;
			else if (sym == 256) {
				lpos = pos, lm = null;
				break;
			} else {
				var add = sym - 254;
				if (sym > 264) {
					var i = sym - 257, b = fleb[i];
					add = bits(dat, pos, (1 << b) - 1) + fl[i];
					pos += b;
				}
				var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
				if (!d) err(3);
				pos += d & 15;
				var dt = fd[dsym];
				if (dsym > 3) {
					var b = fdeb[dsym];
					dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
				}
				if (pos > tbts) {
					if (noSt) err(0);
					break;
				}
				if (resize) cbuf(bt + 131072);
				var end = bt + add;
				if (bt < dt) {
					var shift = dl - dt, dend = Math.min(dt, end);
					if (shift + bt < 0) err(3);
					for (; bt < dend; ++bt) buf[bt] = dict[shift + bt];
				}
				for (; bt < end; ++bt) buf[bt] = buf[bt - dt];
			}
		}
		st.l = lm, st.p = lpos, st.b = bt, st.f = final;
		if (lm) final = 1, st.m = lbt, st.d = dm, st.n = dbt;
	} while (!final);
	return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /*#__PURE__*/ new u8(0);
var zls = function(d, dict) {
	if ((d[0] & 15) != 8 || d[0] >> 4 > 7 || (d[0] << 8 | d[1]) % 31) err(6, "invalid zlib data");
	if ((d[1] >> 5 & 1) == +!dict) err(6, "invalid zlib data: " + (d[1] & 32 ? "need" : "unexpected") + " dictionary");
	return (d[1] >> 3 & 4) + 2;
};
/**
* Expands Zlib data
* @param data The data to decompress
* @param opts The decompression options
* @returns The decompressed version of the data
*/
function unzlibSync(data, opts) {
	return inflt(data.subarray(zls(data, opts && opts.dictionary), -4), { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /*#__PURE__*/ new TextDecoder();
try {
	td.decode(et, { stream: true });
} catch (e) {}
//#endregion
//#region ../../node_modules/three/examples/jsm/curves/NURBSUtils.js
/**
* @module NURBSUtils
* @three_import import * as NURBSUtils from 'three/addons/curves/NURBSUtils.js';
*/
/**
* Finds knot vector span.
*
* @param {number} p - The degree.
* @param {number} u - The parametric value.
* @param {Array<number>} U - The knot vector.
* @return {number} The span.
*/
function findSpan(p, u, U) {
	const n = U.length - p - 1;
	if (u >= U[n]) return n - 1;
	if (u <= U[p]) return p;
	let low = p;
	let high = n;
	let mid = Math.floor((low + high) / 2);
	while (u < U[mid] || u >= U[mid + 1]) {
		if (u < U[mid]) high = mid;
		else low = mid;
		mid = Math.floor((low + high) / 2);
	}
	return mid;
}
/**
* Calculates basis functions. See The NURBS Book, page 70, algorithm A2.2.
*
* @param {number} span - The span in which `u` lies.
* @param {number} u - The parametric value.
* @param {number} p - The degree.
* @param {Array<number>} U - The knot vector.
* @return {Array<number>} Array[p+1] with basis functions values.
*/
function calcBasisFunctions(span, u, p, U) {
	const N = [];
	const left = [];
	const right = [];
	N[0] = 1;
	for (let j = 1; j <= p; ++j) {
		left[j] = u - U[span + 1 - j];
		right[j] = U[span + j] - u;
		let saved = 0;
		for (let r = 0; r < j; ++r) {
			const rv = right[r + 1];
			const lv = left[j - r];
			const temp = N[r] / (rv + lv);
			N[r] = saved + rv * temp;
			saved = lv * temp;
		}
		N[j] = saved;
	}
	return N;
}
/**
* Calculates B-Spline curve points. See The NURBS Book, page 82, algorithm A3.1.
*
* @param {number} p - The degree of the B-Spline.
* @param {Array<number>} U - The knot vector.
* @param {Array<Vector4>} P - The control points
* @param {number} u - The parametric point.
* @return {Vector4} The point for given `u`.
*/
function calcBSplinePoint(p, U, P, u) {
	const span = findSpan(p, u, U);
	const N = calcBasisFunctions(span, u, p, U);
	const C = new Vector4(0, 0, 0, 0);
	for (let j = 0; j <= p; ++j) {
		const point = P[span - p + j];
		const Nj = N[j];
		const wNj = point.w * Nj;
		C.x += point.x * wNj;
		C.y += point.y * wNj;
		C.z += point.z * wNj;
		C.w += point.w * Nj;
	}
	return C;
}
/**
* Calculates basis functions derivatives. See The NURBS Book, page 72, algorithm A2.3.
*
* @param {number} span - The span in which `u` lies.
* @param {number} u - The parametric point.
* @param {number} p - The degree.
* @param {number} n - number of derivatives to calculate
* @param {Array<number>} U - The knot vector.
* @return {Array<Array<number>>} An array[n+1][p+1] with basis functions derivatives.
*/
function calcBasisFunctionDerivatives(span, u, p, n, U) {
	const zeroArr = [];
	for (let i = 0; i <= p; ++i) zeroArr[i] = 0;
	const ders = [];
	for (let i = 0; i <= n; ++i) ders[i] = zeroArr.slice(0);
	const ndu = [];
	for (let i = 0; i <= p; ++i) ndu[i] = zeroArr.slice(0);
	ndu[0][0] = 1;
	const left = zeroArr.slice(0);
	const right = zeroArr.slice(0);
	for (let j = 1; j <= p; ++j) {
		left[j] = u - U[span + 1 - j];
		right[j] = U[span + j] - u;
		let saved = 0;
		for (let r = 0; r < j; ++r) {
			const rv = right[r + 1];
			const lv = left[j - r];
			ndu[j][r] = rv + lv;
			const temp = ndu[r][j - 1] / ndu[j][r];
			ndu[r][j] = saved + rv * temp;
			saved = lv * temp;
		}
		ndu[j][j] = saved;
	}
	for (let j = 0; j <= p; ++j) ders[0][j] = ndu[j][p];
	for (let r = 0; r <= p; ++r) {
		let s1 = 0;
		let s2 = 1;
		const a = [];
		for (let i = 0; i <= p; ++i) a[i] = zeroArr.slice(0);
		a[0][0] = 1;
		for (let k = 1; k <= n; ++k) {
			let d = 0;
			const rk = r - k;
			const pk = p - k;
			if (r >= k) {
				a[s2][0] = a[s1][0] / ndu[pk + 1][rk];
				d = a[s2][0] * ndu[rk][pk];
			}
			const j1 = rk >= -1 ? 1 : -rk;
			const j2 = r - 1 <= pk ? k - 1 : p - r;
			for (let j = j1; j <= j2; ++j) {
				a[s2][j] = (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j];
				d += a[s2][j] * ndu[rk + j][pk];
			}
			if (r <= pk) {
				a[s2][k] = -a[s1][k - 1] / ndu[pk + 1][r];
				d += a[s2][k] * ndu[r][pk];
			}
			ders[k][r] = d;
			const j = s1;
			s1 = s2;
			s2 = j;
		}
	}
	let r = p;
	for (let k = 1; k <= n; ++k) {
		for (let j = 0; j <= p; ++j) ders[k][j] *= r;
		r *= p - k;
	}
	return ders;
}
/**
* Calculates derivatives of a B-Spline. See The NURBS Book, page 93, algorithm A3.2.
*
* @param {number} p - The degree.
* @param {Array<number>} U - The knot vector.
* @param {Array<Vector4>} P - The control points
* @param {number} u - The parametric point.
* @param {number} nd - The number of derivatives.
* @return {Array<Vector4>} An array[d+1] with derivatives.
*/
function calcBSplineDerivatives(p, U, P, u, nd) {
	const du = nd < p ? nd : p;
	const CK = [];
	const span = findSpan(p, u, U);
	const nders = calcBasisFunctionDerivatives(span, u, p, du, U);
	const Pw = [];
	for (let i = 0; i < P.length; ++i) {
		const point = P[i].clone();
		const w = point.w;
		point.x *= w;
		point.y *= w;
		point.z *= w;
		Pw[i] = point;
	}
	for (let k = 0; k <= du; ++k) {
		const point = Pw[span - p].clone().multiplyScalar(nders[k][0]);
		for (let j = 1; j <= p; ++j) point.add(Pw[span - p + j].clone().multiplyScalar(nders[k][j]));
		CK[k] = point;
	}
	for (let k = du + 1; k <= nd + 1; ++k) CK[k] = new Vector4(0, 0, 0);
	return CK;
}
/**
* Calculates "K over I".
*
* @param {number} k - The K value.
* @param {number} i - The I value.
* @return {number} k!/(i!(k-i)!)
*/
function calcKoverI(k, i) {
	let nom = 1;
	for (let j = 2; j <= k; ++j) nom *= j;
	let denom = 1;
	for (let j = 2; j <= i; ++j) denom *= j;
	for (let j = 2; j <= k - i; ++j) denom *= j;
	return nom / denom;
}
/**
* Calculates derivatives (0-nd) of rational curve. See The NURBS Book, page 127, algorithm A4.2.
*
* @param {Array<Vector4>} Pders - Array with derivatives.
* @return {Array<Vector3>} An array with derivatives for rational curve.
*/
function calcRationalCurveDerivatives(Pders) {
	const nd = Pders.length;
	const Aders = [];
	const wders = [];
	for (let i = 0; i < nd; ++i) {
		const point = Pders[i];
		Aders[i] = new Vector3(point.x, point.y, point.z);
		wders[i] = point.w;
	}
	const CK = [];
	for (let k = 0; k < nd; ++k) {
		const v = Aders[k].clone();
		for (let i = 1; i <= k; ++i) v.sub(CK[k - i].clone().multiplyScalar(calcKoverI(k, i) * wders[i]));
		CK[k] = v.divideScalar(wders[0]);
	}
	return CK;
}
/**
* Calculates NURBS curve derivatives. See The NURBS Book, page 127, algorithm A4.2.
*
* @param {number} p - The degree.
* @param {Array<number>} U - The knot vector.
* @param {Array<Vector4>} P - The control points in homogeneous space.
* @param {number} u - The parametric point.
* @param {number} nd - The number of derivatives.
* @return {Array<Vector3>} array with derivatives for rational curve.
*/
function calcNURBSDerivatives(p, U, P, u, nd) {
	return calcRationalCurveDerivatives(calcBSplineDerivatives(p, U, P, u, nd));
}
//#endregion
//#region ../../node_modules/three/examples/jsm/curves/NURBSCurve.js
/**
* This class represents a NURBS curve.
*
* Implementation is based on `(x, y [, z=0 [, w=1]])` control points with `w=weight`.
*
* @augments Curve
* @three_import import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js';
*/
var NURBSCurve = class extends Curve {
	/**
	* Constructs a new NURBS curve.
	*
	* @param {number} degree - The NURBS degree.
	* @param {Array<number>} knots - The knots as a flat array of numbers.
	* @param {Array<Vector2|Vector3|Vector4>} controlPoints - An array holding control points.
	* @param {number} [startKnot] - Index of the start knot into the `knots` array.
	* @param {number} [endKnot] - Index of the end knot into the `knots` array.
	*/
	constructor(degree, knots, controlPoints, startKnot, endKnot) {
		super();
		const knotsLength = knots ? knots.length - 1 : 0;
		const pointsLength = controlPoints ? controlPoints.length : 0;
		/**
		* The NURBS degree.
		*
		* @type {number}
		*/
		this.degree = degree;
		/**
		* The knots as a flat array of numbers.
		*
		* @type {Array<number>}
		*/
		this.knots = knots;
		/**
		* An array of control points.
		*
		* @type {Array<Vector4>}
		*/
		this.controlPoints = [];
		/**
		* Index of the start knot into the `knots` array.
		*
		* @type {number}
		*/
		this.startKnot = startKnot || 0;
		/**
		* Index of the end knot into the `knots` array.
		*
		* @type {number}
		*/
		this.endKnot = endKnot || knotsLength;
		for (let i = 0; i < pointsLength; ++i) {
			const point = controlPoints[i];
			this.controlPoints[i] = new Vector4(point.x, point.y, point.z, point.w);
		}
	}
	/**
	* This method returns a vector in 3D space for the given interpolation factor.
	*
	* @param {number} t - A interpolation factor representing a position on the curve. Must be in the range `[0,1]`.
	* @param {Vector3} [optionalTarget] - The optional target vector the result is written to.
	* @return {Vector3} The position on the curve.
	*/
	getPoint(t, optionalTarget = new Vector3()) {
		const point = optionalTarget;
		const u = this.knots[this.startKnot] + t * (this.knots[this.endKnot] - this.knots[this.startKnot]);
		const hpoint = calcBSplinePoint(this.degree, this.knots, this.controlPoints, u);
		if (hpoint.w !== 1) hpoint.divideScalar(hpoint.w);
		return point.set(hpoint.x, hpoint.y, hpoint.z);
	}
	/**
	* Returns a unit vector tangent for the given interpolation factor.
	*
	* @param {number} t - The interpolation factor.
	* @param {Vector3} [optionalTarget] - The optional target vector the result is written to.
	* @return {Vector3} The tangent vector.
	*/
	getTangent(t, optionalTarget = new Vector3()) {
		const tangent = optionalTarget;
		const u = this.knots[0] + t * (this.knots[this.knots.length - 1] - this.knots[0]);
		const ders = calcNURBSDerivatives(this.degree, this.knots, this.controlPoints, u, 1);
		tangent.copy(ders[1]).normalize();
		return tangent;
	}
	toJSON() {
		const data = super.toJSON();
		data.degree = this.degree;
		data.knots = [...this.knots];
		data.controlPoints = this.controlPoints.map((p) => p.toArray());
		data.startKnot = this.startKnot;
		data.endKnot = this.endKnot;
		return data;
	}
	fromJSON(json) {
		super.fromJSON(json);
		this.degree = json.degree;
		this.knots = [...json.knots];
		this.controlPoints = json.controlPoints.map((p) => new Vector4(p[0], p[1], p[2], p[3]));
		this.startKnot = json.startKnot;
		this.endKnot = json.endKnot;
		return this;
	}
};
//#endregion
//#region ../../node_modules/three/examples/jsm/loaders/FBXLoader.js
var fbxTree;
var connections;
var sceneGraph;
/**
* A loader for the FBX format.
*
* Requires FBX file to be >= 7.0 and in ASCII or >= 6400 in Binary format.
* Versions lower than this may load but will probably have errors.
*
* Needs Support:
* - Morph normals / blend shape normals
*
* FBX format references:
* - [C++ SDK reference](https://help.autodesk.com/view/FBX/2017/ENU/?guid=__cpp_ref_index_html)
*
* Binary format specification:
* - [FBX binary file format specification](https://code.blender.org/2013/08/fbx-binary-file-format-specification/)
*
* ```js
* const loader = new FBXLoader();
* const object = await loader.loadAsync( 'models/fbx/stanford-bunny.fbx' );
* scene.add( object );
* ```
*
* @augments Loader
* @three_import import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
*/
var FBXLoader = class extends Loader {
	/**
	* Constructs a new FBX loader.
	*
	* @param {LoadingManager} [manager] - The loading manager.
	*/
	constructor(manager) {
		super(manager);
	}
	/**
	* Starts loading from the given URL and passes the loaded FBX asset
	* to the `onLoad()` callback.
	*
	* @param {string} url - The path/URL of the file to be loaded. This can also be a data URI.
	* @param {function(Group)} onLoad - Executed when the loading process has been finished.
	* @param {onProgressCallback} onProgress - Executed while the loading is in progress.
	* @param {onErrorCallback} onError - Executed when errors occur.
	*/
	load(url, onLoad, onProgress, onError) {
		const scope = this;
		const path = scope.path === "" ? LoaderUtils.extractUrlBase(url) : scope.path;
		const loader = new FileLoader(this.manager);
		loader.setPath(scope.path);
		loader.setResponseType("arraybuffer");
		loader.setRequestHeader(scope.requestHeader);
		loader.setWithCredentials(scope.withCredentials);
		loader.load(url, function(buffer) {
			try {
				onLoad(scope.parse(buffer, path));
			} catch (e) {
				if (onError) onError(e);
				else console.error(e);
				scope.manager.itemError(url);
			}
		}, onProgress, onError);
	}
	/**
	* Parses the given FBX data and returns the resulting group.
	*
	* @param {ArrayBuffer} FBXBuffer - The raw FBX data as an array buffer.
	* @param {string} path - The URL base path.
	* @return {Group} An object representing the parsed asset.
	*/
	parse(FBXBuffer, path) {
		if (isFbxFormatBinary(FBXBuffer)) fbxTree = new BinaryParser().parse(FBXBuffer);
		else {
			const FBXText = convertArrayBufferToString(FBXBuffer);
			if (!isFbxFormatASCII(FBXText)) throw new Error("THREE.FBXLoader: Unknown format.");
			if (getFbxVersion(FBXText) < 7e3) throw new Error("THREE.FBXLoader: FBX version not supported, FileVersion: " + getFbxVersion(FBXText));
			fbxTree = new TextParser().parse(FBXText);
		}
		return new FBXTreeParser(new TextureLoader(this.manager).setPath(this.resourcePath || path).setCrossOrigin(this.crossOrigin), this.manager).parse(fbxTree);
	}
};
var FBXTreeParser = class {
	constructor(textureLoader, manager) {
		this.textureLoader = textureLoader;
		this.manager = manager;
	}
	parse() {
		connections = this.parseConnections();
		const images = this.parseImages();
		const textures = this.parseTextures(images);
		const materials = this.parseMaterials(textures);
		const deformers = this.parseDeformers();
		const geometryMap = new GeometryParser().parse(deformers);
		this.parseScene(deformers, geometryMap, materials);
		return sceneGraph;
	}
	parseConnections() {
		const connectionMap = /* @__PURE__ */ new Map();
		if ("Connections" in fbxTree) fbxTree.Connections.connections.forEach(function(rawConnection) {
			const fromID = rawConnection[0];
			const toID = rawConnection[1];
			const relationship = rawConnection[2];
			if (!connectionMap.has(fromID)) connectionMap.set(fromID, {
				parents: [],
				children: []
			});
			const parentRelationship = {
				ID: toID,
				relationship
			};
			connectionMap.get(fromID).parents.push(parentRelationship);
			if (!connectionMap.has(toID)) connectionMap.set(toID, {
				parents: [],
				children: []
			});
			const childRelationship = {
				ID: fromID,
				relationship
			};
			connectionMap.get(toID).children.push(childRelationship);
		});
		return connectionMap;
	}
	parseImages() {
		const images = {};
		const blobs = {};
		if ("Video" in fbxTree.Objects) {
			const videoNodes = fbxTree.Objects.Video;
			for (const nodeID in videoNodes) {
				const videoNode = videoNodes[nodeID];
				const id = parseInt(nodeID);
				images[id] = videoNode.RelativeFilename || videoNode.Filename;
				if ("Content" in videoNode) {
					const arrayBufferContent = videoNode.Content instanceof ArrayBuffer && videoNode.Content.byteLength > 0;
					const base64Content = typeof videoNode.Content === "string" && videoNode.Content !== "";
					if (arrayBufferContent || base64Content) {
						const image = this.parseImage(videoNodes[nodeID]);
						blobs[videoNode.RelativeFilename || videoNode.Filename] = image;
					}
				}
			}
		}
		for (const id in images) {
			const filename = images[id];
			if (blobs[filename] !== void 0) images[id] = blobs[filename];
			else images[id] = images[id].split("\\").pop();
		}
		return images;
	}
	parseImage(videoNode) {
		const content = videoNode.Content;
		const fileName = videoNode.RelativeFilename || videoNode.Filename;
		const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
		let type;
		switch (extension) {
			case "bmp":
				type = "image/bmp";
				break;
			case "jpg":
			case "jpeg":
				type = "image/jpeg";
				break;
			case "png":
				type = "image/png";
				break;
			case "tif":
				type = "image/tiff";
				break;
			case "tga":
				if (this.manager.getHandler(".tga") === null) console.warn("FBXLoader: TGA loader not found, skipping ", fileName);
				type = "image/tga";
				break;
			case "webp":
				type = "image/webp";
				break;
			default:
				console.warn("FBXLoader: Image type \"" + extension + "\" is not supported.");
				return;
		}
		if (typeof content === "string") return "data:" + type + ";base64," + content;
		else {
			const array = new Uint8Array(content);
			return window.URL.createObjectURL(new Blob([array], { type }));
		}
	}
	parseTextures(images) {
		const textureMap = /* @__PURE__ */ new Map();
		if ("Texture" in fbxTree.Objects) {
			const textureNodes = fbxTree.Objects.Texture;
			for (const nodeID in textureNodes) {
				const texture = this.parseTexture(textureNodes[nodeID], images);
				textureMap.set(parseInt(nodeID), texture);
			}
		}
		return textureMap;
	}
	parseTexture(textureNode, images) {
		const texture = this.loadTexture(textureNode, images);
		texture.ID = textureNode.id;
		texture.name = textureNode.attrName;
		const wrapModeU = textureNode.WrapModeU;
		const wrapModeV = textureNode.WrapModeV;
		const valueU = wrapModeU !== void 0 ? wrapModeU.value : 0;
		const valueV = wrapModeV !== void 0 ? wrapModeV.value : 0;
		texture.wrapS = valueU === 0 ? RepeatWrapping : ClampToEdgeWrapping;
		texture.wrapT = valueV === 0 ? RepeatWrapping : ClampToEdgeWrapping;
		if ("Scaling" in textureNode) {
			const values = textureNode.Scaling.value;
			texture.repeat.x = values[0];
			texture.repeat.y = values[1];
		}
		if ("Translation" in textureNode) {
			const values = textureNode.Translation.value;
			texture.offset.x = values[0];
			texture.offset.y = values[1];
		}
		return texture;
	}
	loadTexture(textureNode, images) {
		const extension = textureNode.FileName.split(".").pop().toLowerCase();
		let loader = this.manager.getHandler(`.${extension}`);
		if (loader === null) loader = this.textureLoader;
		const loaderPath = loader.path;
		if (!loaderPath) loader.setPath(this.textureLoader.path);
		const children = connections.get(textureNode.id).children;
		let fileName;
		if (children !== void 0 && children.length > 0 && images[children[0].ID] !== void 0) {
			fileName = images[children[0].ID];
			if (fileName.indexOf("blob:") === 0 || fileName.indexOf("data:") === 0) loader.setPath(void 0);
		}
		if (fileName === void 0) {
			console.warn("FBXLoader: Undefined filename, creating placeholder texture.");
			return new Texture();
		}
		const texture = loader.load(fileName);
		loader.setPath(loaderPath);
		return texture;
	}
	parseMaterials(textureMap) {
		const materialMap = /* @__PURE__ */ new Map();
		if ("Material" in fbxTree.Objects) {
			const materialNodes = fbxTree.Objects.Material;
			for (const nodeID in materialNodes) {
				const material = this.parseMaterial(materialNodes[nodeID], textureMap);
				if (material !== null) materialMap.set(parseInt(nodeID), material);
			}
		}
		return materialMap;
	}
	parseMaterial(materialNode, textureMap) {
		const ID = materialNode.id;
		const name = materialNode.attrName;
		let type = materialNode.ShadingModel;
		if (typeof type === "object") type = type.value;
		if (!connections.has(ID)) return null;
		const parameters = this.parseParameters(materialNode, textureMap, ID);
		let material;
		switch (type.toLowerCase()) {
			case "phong":
				material = new MeshPhongMaterial();
				break;
			case "lambert":
				material = new MeshLambertMaterial();
				break;
			default:
				console.warn("THREE.FBXLoader: unknown material type \"%s\". Defaulting to MeshPhongMaterial.", type);
				material = new MeshPhongMaterial();
		}
		material.setValues(parameters);
		material.name = name;
		return material;
	}
	parseParameters(materialNode, textureMap, ID) {
		const parameters = {};
		if (materialNode.BumpFactor) parameters.bumpScale = materialNode.BumpFactor.value;
		if (materialNode.Diffuse) parameters.color = ColorManagement.colorSpaceToWorking(new Color().fromArray(materialNode.Diffuse.value), SRGBColorSpace);
		else if (materialNode.DiffuseColor && (materialNode.DiffuseColor.type === "Color" || materialNode.DiffuseColor.type === "ColorRGB")) parameters.color = ColorManagement.colorSpaceToWorking(new Color().fromArray(materialNode.DiffuseColor.value), SRGBColorSpace);
		if (materialNode.DisplacementFactor) parameters.displacementScale = materialNode.DisplacementFactor.value;
		if (materialNode.Emissive) parameters.emissive = ColorManagement.colorSpaceToWorking(new Color().fromArray(materialNode.Emissive.value), SRGBColorSpace);
		else if (materialNode.EmissiveColor && (materialNode.EmissiveColor.type === "Color" || materialNode.EmissiveColor.type === "ColorRGB")) parameters.emissive = ColorManagement.colorSpaceToWorking(new Color().fromArray(materialNode.EmissiveColor.value), SRGBColorSpace);
		if (materialNode.EmissiveFactor) parameters.emissiveIntensity = parseFloat(materialNode.EmissiveFactor.value);
		parameters.opacity = 1 - (materialNode.TransparencyFactor ? parseFloat(materialNode.TransparencyFactor.value) : 0);
		if (parameters.opacity === 1 || parameters.opacity === 0) {
			parameters.opacity = materialNode.Opacity ? parseFloat(materialNode.Opacity.value) : null;
			if (parameters.opacity === null) parameters.opacity = 1;
		}
		if (parameters.opacity < 1) parameters.transparent = true;
		if (materialNode.ReflectionFactor) parameters.reflectivity = materialNode.ReflectionFactor.value;
		if (materialNode.Shininess) parameters.shininess = materialNode.Shininess.value;
		if (materialNode.Specular) parameters.specular = ColorManagement.colorSpaceToWorking(new Color().fromArray(materialNode.Specular.value), SRGBColorSpace);
		else if (materialNode.SpecularColor && materialNode.SpecularColor.type === "Color") parameters.specular = ColorManagement.colorSpaceToWorking(new Color().fromArray(materialNode.SpecularColor.value), SRGBColorSpace);
		const scope = this;
		connections.get(ID).children.forEach(function(child) {
			const type = child.relationship;
			switch (type) {
				case "Bump":
					parameters.bumpMap = scope.getTexture(textureMap, child.ID);
					break;
				case "Maya|TEX_ao_map":
					parameters.aoMap = scope.getTexture(textureMap, child.ID);
					break;
				case "DiffuseColor":
				case "Maya|TEX_color_map":
					parameters.map = scope.getTexture(textureMap, child.ID);
					if (parameters.map !== void 0) parameters.map.colorSpace = SRGBColorSpace;
					break;
				case "DisplacementColor":
					parameters.displacementMap = scope.getTexture(textureMap, child.ID);
					break;
				case "EmissiveColor":
					parameters.emissiveMap = scope.getTexture(textureMap, child.ID);
					if (parameters.emissiveMap !== void 0) parameters.emissiveMap.colorSpace = SRGBColorSpace;
					break;
				case "NormalMap":
				case "Maya|TEX_normal_map":
					parameters.normalMap = scope.getTexture(textureMap, child.ID);
					break;
				case "ReflectionColor":
					parameters.envMap = scope.getTexture(textureMap, child.ID);
					if (parameters.envMap !== void 0) {
						parameters.envMap.mapping = 303;
						parameters.envMap.colorSpace = SRGBColorSpace;
					}
					break;
				case "SpecularColor":
					parameters.specularMap = scope.getTexture(textureMap, child.ID);
					if (parameters.specularMap !== void 0) parameters.specularMap.colorSpace = SRGBColorSpace;
					break;
				case "TransparentColor":
				case "TransparencyFactor":
					parameters.alphaMap = scope.getTexture(textureMap, child.ID);
					parameters.transparent = true;
					break;
				default: console.warn("THREE.FBXLoader: %s map is not supported in three.js, skipping texture.", type);
			}
		});
		return parameters;
	}
	getTexture(textureMap, id) {
		if ("LayeredTexture" in fbxTree.Objects && id in fbxTree.Objects.LayeredTexture) {
			console.warn("THREE.FBXLoader: layered textures are not supported in three.js. Discarding all but first layer.");
			id = connections.get(id).children[0].ID;
		}
		return textureMap.get(id);
	}
	parseDeformers() {
		const skeletons = {};
		const morphTargets = {};
		if ("Deformer" in fbxTree.Objects) {
			const DeformerNodes = fbxTree.Objects.Deformer;
			for (const nodeID in DeformerNodes) {
				const deformerNode = DeformerNodes[nodeID];
				const relationships = connections.get(parseInt(nodeID));
				if (deformerNode.attrType === "Skin") {
					const skeleton = this.parseSkeleton(relationships, DeformerNodes);
					skeleton.ID = nodeID;
					if (relationships.parents.length > 1) console.warn("THREE.FBXLoader: skeleton attached to more than one geometry is not supported.");
					skeleton.geometryID = relationships.parents[0].ID;
					skeletons[nodeID] = skeleton;
				} else if (deformerNode.attrType === "BlendShape") {
					const morphTarget = { id: nodeID };
					morphTarget.rawTargets = this.parseMorphTargets(relationships, DeformerNodes);
					morphTarget.id = nodeID;
					if (relationships.parents.length > 1) console.warn("THREE.FBXLoader: morph target attached to more than one geometry is not supported.");
					morphTargets[nodeID] = morphTarget;
				}
			}
		}
		return {
			skeletons,
			morphTargets
		};
	}
	parseSkeleton(relationships, deformerNodes) {
		const rawBones = [];
		relationships.children.forEach(function(child) {
			const boneNode = deformerNodes[child.ID];
			if (boneNode.attrType !== "Cluster") return;
			const rawBone = {
				ID: child.ID,
				indices: [],
				weights: [],
				transformLink: new Matrix4().fromArray(boneNode.TransformLink.a)
			};
			if ("Indexes" in boneNode) {
				rawBone.indices = boneNode.Indexes.a;
				rawBone.weights = boneNode.Weights.a;
			}
			rawBones.push(rawBone);
		});
		return {
			rawBones,
			bones: []
		};
	}
	parseMorphTargets(relationships, deformerNodes) {
		const rawMorphTargets = [];
		for (let i = 0; i < relationships.children.length; i++) {
			const child = relationships.children[i];
			const morphTargetNode = deformerNodes[child.ID];
			const rawMorphTarget = {
				name: morphTargetNode.attrName,
				initialWeight: morphTargetNode.DeformPercent,
				id: morphTargetNode.id,
				fullWeights: morphTargetNode.FullWeights.a
			};
			if (morphTargetNode.attrType !== "BlendShapeChannel") return;
			rawMorphTarget.geoID = connections.get(parseInt(child.ID)).children.filter(function(child) {
				return child.relationship === void 0;
			})[0].ID;
			rawMorphTargets.push(rawMorphTarget);
		}
		return rawMorphTargets;
	}
	parseScene(deformers, geometryMap, materialMap) {
		sceneGraph = new Group();
		const modelMap = this.parseModels(deformers.skeletons, geometryMap, materialMap);
		const modelNodes = fbxTree.Objects.Model;
		const scope = this;
		modelMap.forEach(function(model) {
			const modelNode = modelNodes[model.ID];
			scope.setLookAtProperties(model, modelNode);
			connections.get(model.ID).parents.forEach(function(connection) {
				const parent = modelMap.get(connection.ID);
				if (parent !== void 0) parent.add(model);
			});
			if (model.parent === null) sceneGraph.add(model);
		});
		this.addGlobalSceneSettings();
		sceneGraph.traverse(function(node) {
			if (node.userData.transformData) {
				if (node.parent) {
					node.userData.transformData.parentMatrix = node.parent.matrix;
					node.userData.transformData.parentMatrixWorld = node.parent.matrixWorld;
				}
				const transform = generateTransform(node.userData.transformData);
				node.applyMatrix4(transform);
				node.updateWorldMatrix();
			}
		});
		const bindPoseMatrices = this.parsePoseNodes();
		const clusterBoneIDs = /* @__PURE__ */ new Set();
		for (const ID in deformers.skeletons) deformers.skeletons[ID].rawBones.forEach(function(_, i) {
			const bone = deformers.skeletons[ID].bones[i];
			if (bone) clusterBoneIDs.add(bone.ID);
		});
		const tempMatrix = new Matrix4();
		sceneGraph.traverse(function(node) {
			if (node.isBone && node.ID !== void 0 && !clusterBoneIDs.has(node.ID)) {
				const bindPose = bindPoseMatrices[node.ID];
				if (bindPose !== void 0) {
					if (node.parent) {
						tempMatrix.copy(node.parent.matrixWorld).invert();
						tempMatrix.multiply(bindPose);
					} else tempMatrix.copy(bindPose);
					tempMatrix.decompose(node.position, node.quaternion, node.scale);
					node.updateMatrix();
					node.matrixWorld.copy(bindPose);
				}
			}
		});
		this.bindSkeleton(deformers.skeletons, geometryMap, modelMap);
		const animations = new AnimationParser().parse();
		if (sceneGraph.children.length === 1 && sceneGraph.children[0].isGroup) {
			sceneGraph.children[0].animations = animations;
			sceneGraph = sceneGraph.children[0];
		}
		sceneGraph.animations = animations;
		if ("GlobalSettings" in fbxTree && "UpAxis" in fbxTree.GlobalSettings) {
			if (fbxTree.GlobalSettings.UpAxis.value === 2) {
				console.warn("THREE.FBXLoader: You are loading an asset with a Z-UP coordinate system. The loader just rotates the asset to transform it into Y-UP. The vertex data are not converted.");
				sceneGraph.rotation.set(-Math.PI / 2, 0, 0);
			}
		}
	}
	parseModels(skeletons, geometryMap, materialMap) {
		const modelMap = /* @__PURE__ */ new Map();
		const modelNodes = fbxTree.Objects.Model;
		for (const nodeID in modelNodes) {
			const id = parseInt(nodeID);
			const node = modelNodes[nodeID];
			const relationships = connections.get(id);
			let model = this.buildSkeleton(relationships, skeletons, id, node.attrName);
			if (!model) {
				switch (node.attrType) {
					case "Camera":
						model = this.createCamera(relationships);
						break;
					case "Light":
						model = this.createLight(relationships);
						break;
					case "Mesh":
						model = this.createMesh(relationships, geometryMap, materialMap);
						break;
					case "NurbsCurve":
						model = this.createCurve(relationships, geometryMap);
						break;
					case "LimbNode":
					case "Root":
						model = new Bone();
						break;
					default: model = new Group();
				}
				model.name = node.attrName ? PropertyBinding.sanitizeNodeName(node.attrName) : "";
				model.userData.originalName = node.attrName;
				model.ID = id;
			}
			this.getTransformData(model, node);
			modelMap.set(id, model);
		}
		return modelMap;
	}
	buildSkeleton(relationships, skeletons, id, name) {
		let bone = null;
		relationships.parents.forEach(function(parent) {
			for (const ID in skeletons) {
				const skeleton = skeletons[ID];
				skeleton.rawBones.forEach(function(rawBone, i) {
					if (rawBone.ID === parent.ID) {
						const subBone = bone;
						bone = new Bone();
						bone.matrixWorld.copy(rawBone.transformLink);
						bone.name = name ? PropertyBinding.sanitizeNodeName(name) : "";
						bone.userData.originalName = name;
						bone.ID = id;
						skeleton.bones[i] = bone;
						if (subBone !== null) bone.add(subBone);
					}
				});
			}
		});
		return bone;
	}
	createCamera(relationships) {
		let model;
		let cameraAttribute;
		relationships.children.forEach(function(child) {
			const attr = fbxTree.Objects.NodeAttribute[child.ID];
			if (attr !== void 0) cameraAttribute = attr;
		});
		if (cameraAttribute === void 0) model = new Object3D();
		else {
			let type = 0;
			if (cameraAttribute.CameraProjectionType !== void 0 && cameraAttribute.CameraProjectionType.value === 1) type = 1;
			let nearClippingPlane = 1;
			if (cameraAttribute.NearPlane !== void 0) nearClippingPlane = cameraAttribute.NearPlane.value / 1e3;
			let farClippingPlane = 1e3;
			if (cameraAttribute.FarPlane !== void 0) farClippingPlane = cameraAttribute.FarPlane.value / 1e3;
			let width = window.innerWidth;
			let height = window.innerHeight;
			if (cameraAttribute.AspectWidth !== void 0 && cameraAttribute.AspectHeight !== void 0) {
				width = cameraAttribute.AspectWidth.value;
				height = cameraAttribute.AspectHeight.value;
			}
			const aspect = width / height;
			let fov = 45;
			if (cameraAttribute.FieldOfView !== void 0) fov = cameraAttribute.FieldOfView.value;
			const focalLength = cameraAttribute.FocalLength ? cameraAttribute.FocalLength.value : null;
			switch (type) {
				case 0:
					model = new PerspectiveCamera(fov, aspect, nearClippingPlane, farClippingPlane);
					if (focalLength !== null) model.setFocalLength(focalLength);
					break;
				case 1:
					console.warn("THREE.FBXLoader: Orthographic cameras not supported yet.");
					model = new Object3D();
					break;
				default:
					console.warn("THREE.FBXLoader: Unknown camera type " + type + ".");
					model = new Object3D();
			}
		}
		return model;
	}
	createLight(relationships) {
		let model;
		let lightAttribute;
		relationships.children.forEach(function(child) {
			const attr = fbxTree.Objects.NodeAttribute[child.ID];
			if (attr !== void 0) lightAttribute = attr;
		});
		if (lightAttribute === void 0) model = new Object3D();
		else {
			let type;
			if (lightAttribute.LightType === void 0) type = 0;
			else type = lightAttribute.LightType.value;
			let color = 16777215;
			if (lightAttribute.Color !== void 0) color = ColorManagement.colorSpaceToWorking(new Color().fromArray(lightAttribute.Color.value), SRGBColorSpace);
			let intensity = lightAttribute.Intensity === void 0 ? 1 : lightAttribute.Intensity.value / 100;
			if (lightAttribute.CastLightOnObject !== void 0 && lightAttribute.CastLightOnObject.value === 0) intensity = 0;
			let distance = 0;
			if (lightAttribute.FarAttenuationEnd !== void 0) if (lightAttribute.EnableFarAttenuation !== void 0 && lightAttribute.EnableFarAttenuation.value === 0) distance = 0;
			else distance = lightAttribute.FarAttenuationEnd.value;
			const decay = 1;
			switch (type) {
				case 0:
					model = new PointLight(color, intensity, distance, decay);
					break;
				case 1:
					model = new DirectionalLight(color, intensity);
					break;
				case 2:
					let angle = Math.PI / 3;
					let penumbra = 0;
					if (lightAttribute.OuterAngle !== void 0) {
						angle = MathUtils.degToRad(lightAttribute.OuterAngle.value);
						if (lightAttribute.InnerAngle !== void 0) {
							penumbra = 1 - lightAttribute.InnerAngle.value / lightAttribute.OuterAngle.value;
							penumbra = Math.max(0, penumbra);
						}
					} else if (lightAttribute.InnerAngle !== void 0) angle = MathUtils.degToRad(lightAttribute.InnerAngle.value);
					model = new SpotLight(color, intensity, distance, angle, penumbra, decay);
					break;
				default:
					console.warn("THREE.FBXLoader: Unknown light type " + lightAttribute.LightType.value + ", defaulting to a PointLight.");
					model = new PointLight(color, intensity);
			}
			if (lightAttribute.CastShadows !== void 0 && lightAttribute.CastShadows.value === 1) model.castShadow = true;
		}
		return model;
	}
	createMesh(relationships, geometryMap, materialMap) {
		let model;
		let geometry = null;
		let material = null;
		const materials = [];
		relationships.children.forEach(function(child) {
			if (geometryMap.has(child.ID)) geometry = geometryMap.get(child.ID);
			if (materialMap.has(child.ID)) materials.push(materialMap.get(child.ID));
		});
		if (materials.length > 1) material = materials;
		else if (materials.length > 0) material = materials[0];
		else {
			material = new MeshPhongMaterial({
				name: Loader.DEFAULT_MATERIAL_NAME,
				color: 13421772
			});
			materials.push(material);
		}
		if ("color" in geometry.attributes) materials.forEach(function(material) {
			material.vertexColors = true;
		});
		if (geometry.groups.length > 0) {
			let needsDefaultMaterial = false;
			for (let i = 0, il = geometry.groups.length; i < il; i++) {
				const group = geometry.groups[i];
				if (group.materialIndex < 0 || group.materialIndex >= materials.length) {
					group.materialIndex = materials.length;
					needsDefaultMaterial = true;
				}
			}
			if (needsDefaultMaterial) {
				const defaultMaterial = new MeshPhongMaterial();
				materials.push(defaultMaterial);
			}
		}
		if (geometry.FBX_Deformer) {
			model = new SkinnedMesh(geometry, material);
			model.normalizeSkinWeights();
		} else model = new Mesh(geometry, material);
		return model;
	}
	createCurve(relationships, geometryMap) {
		const geometry = relationships.children.reduce(function(geo, child) {
			if (geometryMap.has(child.ID)) geo = geometryMap.get(child.ID);
			return geo;
		}, null);
		const material = new LineBasicMaterial({
			name: Loader.DEFAULT_MATERIAL_NAME,
			color: 3342591,
			linewidth: 1
		});
		return new Line(geometry, material);
	}
	getTransformData(model, modelNode) {
		const transformData = {};
		if ("InheritType" in modelNode) transformData.inheritType = parseInt(modelNode.InheritType.value);
		if ("RotationOrder" in modelNode) transformData.eulerOrder = getEulerOrder(modelNode.RotationOrder.value);
		else transformData.eulerOrder = getEulerOrder(0);
		if ("Lcl_Translation" in modelNode) transformData.translation = modelNode.Lcl_Translation.value;
		if ("PreRotation" in modelNode) transformData.preRotation = modelNode.PreRotation.value;
		if ("Lcl_Rotation" in modelNode) transformData.rotation = modelNode.Lcl_Rotation.value;
		if ("PostRotation" in modelNode) transformData.postRotation = modelNode.PostRotation.value;
		if ("Lcl_Scaling" in modelNode) transformData.scale = modelNode.Lcl_Scaling.value;
		if ("ScalingOffset" in modelNode) transformData.scalingOffset = modelNode.ScalingOffset.value;
		if ("ScalingPivot" in modelNode) transformData.scalingPivot = modelNode.ScalingPivot.value;
		if ("RotationOffset" in modelNode) transformData.rotationOffset = modelNode.RotationOffset.value;
		if ("RotationPivot" in modelNode) transformData.rotationPivot = modelNode.RotationPivot.value;
		model.userData.transformData = transformData;
	}
	setLookAtProperties(model, modelNode) {
		if ("LookAtProperty" in modelNode) connections.get(model.ID).children.forEach(function(child) {
			if (child.relationship === "LookAtProperty") {
				const lookAtTarget = fbxTree.Objects.Model[child.ID];
				if ("Lcl_Translation" in lookAtTarget) {
					const pos = lookAtTarget.Lcl_Translation.value;
					if (model.target !== void 0) {
						model.target.position.fromArray(pos);
						sceneGraph.add(model.target);
					} else model.lookAt(new Vector3().fromArray(pos));
				}
			}
		});
	}
	bindSkeleton(skeletons, geometryMap, modelMap) {
		for (const ID in skeletons) {
			const skeleton = skeletons[ID];
			const boneInverses = [];
			for (let i = 0, l = skeleton.bones.length; i < l; i++) {
				const inverse = new Matrix4();
				if (skeleton.bones[i] && skeleton.rawBones[i]) inverse.copy(skeleton.rawBones[i].transformLink).invert();
				boneInverses.push(inverse);
			}
			connections.get(parseInt(skeleton.ID)).parents.forEach(function(parent) {
				if (geometryMap.has(parent.ID)) {
					const geoID = parent.ID;
					connections.get(geoID).parents.forEach(function(geoConnParent) {
						if (modelMap.has(geoConnParent.ID)) {
							const model = modelMap.get(geoConnParent.ID);
							model.updateMatrixWorld(true);
							model.bind(new Skeleton(skeleton.bones, boneInverses), model.matrixWorld);
						}
					});
				}
			});
		}
	}
	parsePoseNodes() {
		const bindMatrices = {};
		if ("Pose" in fbxTree.Objects) {
			const BindPoseNode = fbxTree.Objects.Pose;
			for (const nodeID in BindPoseNode) if (BindPoseNode[nodeID].attrType === "BindPose" && BindPoseNode[nodeID].NbPoseNodes > 0) {
				const poseNodes = BindPoseNode[nodeID].PoseNode;
				if (Array.isArray(poseNodes)) poseNodes.forEach(function(poseNode) {
					bindMatrices[poseNode.Node] = new Matrix4().fromArray(poseNode.Matrix.a);
				});
				else bindMatrices[poseNodes.Node] = new Matrix4().fromArray(poseNodes.Matrix.a);
			}
		}
		return bindMatrices;
	}
	addGlobalSceneSettings() {
		if ("GlobalSettings" in fbxTree) {
			if ("AmbientColor" in fbxTree.GlobalSettings) {
				const ambientColor = fbxTree.GlobalSettings.AmbientColor.value;
				const r = ambientColor[0];
				const g = ambientColor[1];
				const b = ambientColor[2];
				if (r !== 0 || g !== 0 || b !== 0) {
					const color = new Color().setRGB(r, g, b, SRGBColorSpace);
					sceneGraph.add(new AmbientLight(color, 1));
				}
			}
			if ("UnitScaleFactor" in fbxTree.GlobalSettings) sceneGraph.userData.unitScaleFactor = fbxTree.GlobalSettings.UnitScaleFactor.value;
		}
	}
};
var GeometryParser = class {
	constructor() {
		this.negativeMaterialIndices = false;
	}
	parse(deformers) {
		const geometryMap = /* @__PURE__ */ new Map();
		if ("Geometry" in fbxTree.Objects) {
			const geoNodes = fbxTree.Objects.Geometry;
			for (const nodeID in geoNodes) {
				const relationships = connections.get(parseInt(nodeID));
				const geo = this.parseGeometry(relationships, geoNodes[nodeID], deformers);
				geometryMap.set(parseInt(nodeID), geo);
			}
		}
		if (this.negativeMaterialIndices === true) console.warn("THREE.FBXLoader: The FBX file contains invalid (negative) material indices. The asset might not render as expected.");
		return geometryMap;
	}
	parseGeometry(relationships, geoNode, deformers) {
		switch (geoNode.attrType) {
			case "Mesh": return this.parseMeshGeometry(relationships, geoNode, deformers);
			case "NurbsCurve": return this.parseNurbsGeometry(geoNode);
		}
	}
	parseMeshGeometry(relationships, geoNode, deformers) {
		const skeletons = deformers.skeletons;
		const morphTargets = [];
		const modelNodes = relationships.parents.map(function(parent) {
			return fbxTree.Objects.Model[parent.ID];
		});
		if (modelNodes.length === 0) return;
		const skeleton = relationships.children.reduce(function(skeleton, child) {
			if (skeletons[child.ID] !== void 0) skeleton = skeletons[child.ID];
			return skeleton;
		}, null);
		relationships.children.forEach(function(child) {
			if (deformers.morphTargets[child.ID] !== void 0) morphTargets.push(deformers.morphTargets[child.ID]);
		});
		const modelNode = modelNodes[0];
		const transformData = {};
		if ("RotationOrder" in modelNode) transformData.eulerOrder = getEulerOrder(modelNode.RotationOrder.value);
		if ("InheritType" in modelNode) transformData.inheritType = parseInt(modelNode.InheritType.value);
		if ("GeometricTranslation" in modelNode) transformData.translation = modelNode.GeometricTranslation.value;
		if ("GeometricRotation" in modelNode) transformData.rotation = modelNode.GeometricRotation.value;
		if ("GeometricScaling" in modelNode) transformData.scale = modelNode.GeometricScaling.value;
		const transform = generateTransform(transformData);
		return this.genGeometry(geoNode, skeleton, morphTargets, transform);
	}
	genGeometry(geoNode, skeleton, morphTargets, preTransform) {
		const geo = new BufferGeometry();
		if (geoNode.attrName) geo.name = geoNode.attrName;
		const geoInfo = this.parseGeoNode(geoNode, skeleton);
		const buffers = this.genBuffers(geoInfo);
		const positionAttribute = new Float32BufferAttribute(buffers.vertex, 3);
		positionAttribute.applyMatrix4(preTransform);
		geo.setAttribute("position", positionAttribute);
		if (buffers.colors.length > 0) geo.setAttribute("color", new Float32BufferAttribute(buffers.colors, 3));
		if (skeleton) {
			geo.setAttribute("skinIndex", new Uint16BufferAttribute(buffers.weightsIndices, 4));
			geo.setAttribute("skinWeight", new Float32BufferAttribute(buffers.vertexWeights, 4));
			geo.FBX_Deformer = skeleton;
		}
		if (buffers.normal.length > 0) {
			const normalMatrix = new Matrix3().getNormalMatrix(preTransform);
			const normalAttribute = new Float32BufferAttribute(buffers.normal, 3);
			normalAttribute.applyNormalMatrix(normalMatrix);
			geo.setAttribute("normal", normalAttribute);
		}
		buffers.uvs.forEach(function(uvBuffer, i) {
			const name = i === 0 ? "uv" : `uv${i}`;
			geo.setAttribute(name, new Float32BufferAttribute(buffers.uvs[i], 2));
		});
		if (geoInfo.material && geoInfo.material.mappingType !== "AllSame") {
			let prevMaterialIndex = buffers.materialIndex[0];
			let startIndex = 0;
			buffers.materialIndex.forEach(function(currentIndex, i) {
				if (currentIndex !== prevMaterialIndex) {
					geo.addGroup(startIndex, i - startIndex, prevMaterialIndex);
					prevMaterialIndex = currentIndex;
					startIndex = i;
				}
			});
			if (geo.groups.length > 0) {
				const lastGroup = geo.groups[geo.groups.length - 1];
				const lastIndex = lastGroup.start + lastGroup.count;
				if (lastIndex !== buffers.materialIndex.length) geo.addGroup(lastIndex, buffers.materialIndex.length - lastIndex, prevMaterialIndex);
			}
			if (geo.groups.length === 0) geo.addGroup(0, buffers.materialIndex.length, buffers.materialIndex[0]);
		}
		this.addMorphTargets(geo, geoNode, morphTargets, preTransform);
		return geo;
	}
	parseGeoNode(geoNode, skeleton) {
		const geoInfo = {};
		geoInfo.vertexPositions = geoNode.Vertices !== void 0 ? geoNode.Vertices.a : [];
		geoInfo.vertexIndices = geoNode.PolygonVertexIndex !== void 0 ? geoNode.PolygonVertexIndex.a : [];
		if (geoNode.LayerElementColor && geoNode.LayerElementColor[0].Colors) geoInfo.color = this.parseVertexColors(geoNode.LayerElementColor[0]);
		if (geoNode.LayerElementMaterial) geoInfo.material = this.parseMaterialIndices(geoNode.LayerElementMaterial[0]);
		if (geoNode.LayerElementNormal) geoInfo.normal = this.parseNormals(geoNode.LayerElementNormal[0]);
		if (geoNode.LayerElementUV) {
			geoInfo.uv = [];
			let i = 0;
			while (geoNode.LayerElementUV[i]) {
				if (geoNode.LayerElementUV[i].UV) geoInfo.uv.push(this.parseUVs(geoNode.LayerElementUV[i]));
				i++;
			}
		}
		geoInfo.weightTable = {};
		if (skeleton !== null) {
			geoInfo.skeleton = skeleton;
			skeleton.rawBones.forEach(function(rawBone, i) {
				rawBone.indices.forEach(function(index, j) {
					if (geoInfo.weightTable[index] === void 0) geoInfo.weightTable[index] = [];
					geoInfo.weightTable[index].push({
						id: i,
						weight: rawBone.weights[j]
					});
				});
			});
		}
		return geoInfo;
	}
	genBuffers(geoInfo) {
		const buffers = {
			vertex: [],
			normal: [],
			colors: [],
			uvs: [],
			materialIndex: [],
			vertexWeights: [],
			weightsIndices: []
		};
		let polygonIndex = 0;
		let faceLength = 0;
		let displayedWeightsWarning = false;
		let facePositionIndexes = [];
		let faceNormals = [];
		let faceColors = [];
		let faceUVs = [];
		let faceWeights = [];
		let faceWeightIndices = [];
		const scope = this;
		geoInfo.vertexIndices.forEach(function(vertexIndex, polygonVertexIndex) {
			let materialIndex;
			let endOfFace = false;
			if (vertexIndex < 0) {
				vertexIndex = vertexIndex ^ -1;
				endOfFace = true;
			}
			let weightIndices = [];
			let weights = [];
			facePositionIndexes.push(vertexIndex * 3, vertexIndex * 3 + 1, vertexIndex * 3 + 2);
			if (geoInfo.color) {
				const data = getData(polygonVertexIndex, polygonIndex, vertexIndex, geoInfo.color);
				faceColors.push(data[0], data[1], data[2]);
			}
			if (geoInfo.skeleton) {
				if (geoInfo.weightTable[vertexIndex] !== void 0) geoInfo.weightTable[vertexIndex].forEach(function(wt) {
					weights.push(wt.weight);
					weightIndices.push(wt.id);
				});
				if (weights.length > 4) {
					if (!displayedWeightsWarning) {
						console.warn("THREE.FBXLoader: Vertex has more than 4 skinning weights assigned to vertex. Deleting additional weights.");
						displayedWeightsWarning = true;
					}
					const wIndex = [
						0,
						0,
						0,
						0
					];
					const Weight = [
						0,
						0,
						0,
						0
					];
					weights.forEach(function(weight, weightIndex) {
						let currentWeight = weight;
						let currentIndex = weightIndices[weightIndex];
						Weight.forEach(function(comparedWeight, comparedWeightIndex, comparedWeightArray) {
							if (currentWeight > comparedWeight) {
								comparedWeightArray[comparedWeightIndex] = currentWeight;
								currentWeight = comparedWeight;
								const tmp = wIndex[comparedWeightIndex];
								wIndex[comparedWeightIndex] = currentIndex;
								currentIndex = tmp;
							}
						});
					});
					weightIndices = wIndex;
					weights = Weight;
				}
				while (weights.length < 4) {
					weights.push(0);
					weightIndices.push(0);
				}
				for (let i = 0; i < 4; ++i) {
					faceWeights.push(weights[i]);
					faceWeightIndices.push(weightIndices[i]);
				}
			}
			if (geoInfo.normal) {
				const data = getData(polygonVertexIndex, polygonIndex, vertexIndex, geoInfo.normal);
				faceNormals.push(data[0], data[1], data[2]);
			}
			if (geoInfo.material && geoInfo.material.mappingType !== "AllSame") {
				materialIndex = getData(polygonVertexIndex, polygonIndex, vertexIndex, geoInfo.material)[0];
				if (materialIndex < 0) {
					scope.negativeMaterialIndices = true;
					materialIndex = 0;
				}
			}
			if (geoInfo.uv) geoInfo.uv.forEach(function(uv, i) {
				const data = getData(polygonVertexIndex, polygonIndex, vertexIndex, uv);
				if (faceUVs[i] === void 0) faceUVs[i] = [];
				faceUVs[i].push(data[0]);
				faceUVs[i].push(data[1]);
			});
			faceLength++;
			if (endOfFace) {
				scope.genFace(buffers, geoInfo, facePositionIndexes, materialIndex, faceNormals, faceColors, faceUVs, faceWeights, faceWeightIndices, faceLength);
				polygonIndex++;
				faceLength = 0;
				facePositionIndexes = [];
				faceNormals = [];
				faceColors = [];
				faceUVs = [];
				faceWeights = [];
				faceWeightIndices = [];
			}
		});
		return buffers;
	}
	getNormalNewell(vertices) {
		const normal = new Vector3(0, 0, 0);
		for (let i = 0; i < vertices.length; i++) {
			const current = vertices[i];
			const next = vertices[(i + 1) % vertices.length];
			normal.x += (current.y - next.y) * (current.z + next.z);
			normal.y += (current.z - next.z) * (current.x + next.x);
			normal.z += (current.x - next.x) * (current.y + next.y);
		}
		normal.normalize();
		return normal;
	}
	getNormalTangentAndBitangent(vertices) {
		const normalVector = this.getNormalNewell(vertices);
		const tangent = (Math.abs(normalVector.z) > .5 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1)).cross(normalVector).normalize();
		return {
			normal: normalVector,
			tangent,
			bitangent: normalVector.clone().cross(tangent).normalize()
		};
	}
	flattenVertex(vertex, normalTangent, normalBitangent) {
		return new Vector2(vertex.dot(normalTangent), vertex.dot(normalBitangent));
	}
	genFace(buffers, geoInfo, facePositionIndexes, materialIndex, faceNormals, faceColors, faceUVs, faceWeights, faceWeightIndices, faceLength) {
		let triangles;
		if (faceLength > 3) {
			const vertices = [];
			const positions = geoInfo.baseVertexPositions || geoInfo.vertexPositions;
			for (let i = 0; i < facePositionIndexes.length; i += 3) vertices.push(new Vector3(positions[facePositionIndexes[i]], positions[facePositionIndexes[i + 1]], positions[facePositionIndexes[i + 2]]));
			const { tangent, bitangent } = this.getNormalTangentAndBitangent(vertices);
			const triangulationInput = [];
			for (const vertex of vertices) triangulationInput.push(this.flattenVertex(vertex, tangent, bitangent));
			triangles = ShapeUtils.triangulateShape(triangulationInput, []);
		} else triangles = [[
			0,
			1,
			2
		]];
		for (const [i0, i1, i2] of triangles) {
			buffers.vertex.push(geoInfo.vertexPositions[facePositionIndexes[i0 * 3]]);
			buffers.vertex.push(geoInfo.vertexPositions[facePositionIndexes[i0 * 3 + 1]]);
			buffers.vertex.push(geoInfo.vertexPositions[facePositionIndexes[i0 * 3 + 2]]);
			buffers.vertex.push(geoInfo.vertexPositions[facePositionIndexes[i1 * 3]]);
			buffers.vertex.push(geoInfo.vertexPositions[facePositionIndexes[i1 * 3 + 1]]);
			buffers.vertex.push(geoInfo.vertexPositions[facePositionIndexes[i1 * 3 + 2]]);
			buffers.vertex.push(geoInfo.vertexPositions[facePositionIndexes[i2 * 3]]);
			buffers.vertex.push(geoInfo.vertexPositions[facePositionIndexes[i2 * 3 + 1]]);
			buffers.vertex.push(geoInfo.vertexPositions[facePositionIndexes[i2 * 3 + 2]]);
			if (geoInfo.skeleton) {
				buffers.vertexWeights.push(faceWeights[i0 * 4]);
				buffers.vertexWeights.push(faceWeights[i0 * 4 + 1]);
				buffers.vertexWeights.push(faceWeights[i0 * 4 + 2]);
				buffers.vertexWeights.push(faceWeights[i0 * 4 + 3]);
				buffers.vertexWeights.push(faceWeights[i1 * 4]);
				buffers.vertexWeights.push(faceWeights[i1 * 4 + 1]);
				buffers.vertexWeights.push(faceWeights[i1 * 4 + 2]);
				buffers.vertexWeights.push(faceWeights[i1 * 4 + 3]);
				buffers.vertexWeights.push(faceWeights[i2 * 4]);
				buffers.vertexWeights.push(faceWeights[i2 * 4 + 1]);
				buffers.vertexWeights.push(faceWeights[i2 * 4 + 2]);
				buffers.vertexWeights.push(faceWeights[i2 * 4 + 3]);
				buffers.weightsIndices.push(faceWeightIndices[i0 * 4]);
				buffers.weightsIndices.push(faceWeightIndices[i0 * 4 + 1]);
				buffers.weightsIndices.push(faceWeightIndices[i0 * 4 + 2]);
				buffers.weightsIndices.push(faceWeightIndices[i0 * 4 + 3]);
				buffers.weightsIndices.push(faceWeightIndices[i1 * 4]);
				buffers.weightsIndices.push(faceWeightIndices[i1 * 4 + 1]);
				buffers.weightsIndices.push(faceWeightIndices[i1 * 4 + 2]);
				buffers.weightsIndices.push(faceWeightIndices[i1 * 4 + 3]);
				buffers.weightsIndices.push(faceWeightIndices[i2 * 4]);
				buffers.weightsIndices.push(faceWeightIndices[i2 * 4 + 1]);
				buffers.weightsIndices.push(faceWeightIndices[i2 * 4 + 2]);
				buffers.weightsIndices.push(faceWeightIndices[i2 * 4 + 3]);
			}
			if (geoInfo.color) {
				buffers.colors.push(faceColors[i0 * 3]);
				buffers.colors.push(faceColors[i0 * 3 + 1]);
				buffers.colors.push(faceColors[i0 * 3 + 2]);
				buffers.colors.push(faceColors[i1 * 3]);
				buffers.colors.push(faceColors[i1 * 3 + 1]);
				buffers.colors.push(faceColors[i1 * 3 + 2]);
				buffers.colors.push(faceColors[i2 * 3]);
				buffers.colors.push(faceColors[i2 * 3 + 1]);
				buffers.colors.push(faceColors[i2 * 3 + 2]);
			}
			if (geoInfo.material && geoInfo.material.mappingType !== "AllSame") {
				buffers.materialIndex.push(materialIndex);
				buffers.materialIndex.push(materialIndex);
				buffers.materialIndex.push(materialIndex);
			}
			if (geoInfo.normal) {
				buffers.normal.push(faceNormals[i0 * 3]);
				buffers.normal.push(faceNormals[i0 * 3 + 1]);
				buffers.normal.push(faceNormals[i0 * 3 + 2]);
				buffers.normal.push(faceNormals[i1 * 3]);
				buffers.normal.push(faceNormals[i1 * 3 + 1]);
				buffers.normal.push(faceNormals[i1 * 3 + 2]);
				buffers.normal.push(faceNormals[i2 * 3]);
				buffers.normal.push(faceNormals[i2 * 3 + 1]);
				buffers.normal.push(faceNormals[i2 * 3 + 2]);
			}
			if (geoInfo.uv) geoInfo.uv.forEach(function(uv, j) {
				if (buffers.uvs[j] === void 0) buffers.uvs[j] = [];
				buffers.uvs[j].push(faceUVs[j][i0 * 2]);
				buffers.uvs[j].push(faceUVs[j][i0 * 2 + 1]);
				buffers.uvs[j].push(faceUVs[j][i1 * 2]);
				buffers.uvs[j].push(faceUVs[j][i1 * 2 + 1]);
				buffers.uvs[j].push(faceUVs[j][i2 * 2]);
				buffers.uvs[j].push(faceUVs[j][i2 * 2 + 1]);
			});
		}
	}
	addMorphTargets(parentGeo, parentGeoNode, morphTargets, preTransform) {
		if (morphTargets.length === 0) return;
		parentGeo.morphTargetsRelative = true;
		parentGeo.morphAttributes.position = [];
		const morphPreTransform = preTransform.clone().setPosition(0, 0, 0);
		const scope = this;
		morphTargets.forEach(function(morphTarget) {
			morphTarget.rawTargets.forEach(function(rawTarget) {
				const morphGeoNode = fbxTree.Objects.Geometry[rawTarget.geoID];
				if (morphGeoNode !== void 0) scope.genMorphGeometry(parentGeo, parentGeoNode, morphGeoNode, morphPreTransform, rawTarget.name);
			});
		});
	}
	genMorphGeometry(parentGeo, parentGeoNode, morphGeoNode, preTransform, name) {
		const basePositions = parentGeoNode.Vertices !== void 0 ? parentGeoNode.Vertices.a : [];
		const baseIndices = parentGeoNode.PolygonVertexIndex !== void 0 ? parentGeoNode.PolygonVertexIndex.a : [];
		const morphPositionsSparse = morphGeoNode.Vertices !== void 0 ? morphGeoNode.Vertices.a : [];
		const morphIndices = morphGeoNode.Indexes !== void 0 ? morphGeoNode.Indexes.a : [];
		const length = parentGeo.attributes.position.count * 3;
		const morphPositions = new Float32Array(length);
		for (let i = 0; i < morphIndices.length; i++) {
			const morphIndex = morphIndices[i] * 3;
			morphPositions[morphIndex] = morphPositionsSparse[i * 3];
			morphPositions[morphIndex + 1] = morphPositionsSparse[i * 3 + 1];
			morphPositions[morphIndex + 2] = morphPositionsSparse[i * 3 + 2];
		}
		const morphGeoInfo = {
			vertexIndices: baseIndices,
			vertexPositions: morphPositions,
			baseVertexPositions: basePositions
		};
		const morphBuffers = this.genBuffers(morphGeoInfo);
		const positionAttribute = new Float32BufferAttribute(morphBuffers.vertex, 3);
		positionAttribute.name = name || morphGeoNode.attrName;
		positionAttribute.applyMatrix4(preTransform);
		parentGeo.morphAttributes.position.push(positionAttribute);
	}
	parseNormals(NormalNode) {
		const mappingType = NormalNode.MappingInformationType;
		const referenceType = NormalNode.ReferenceInformationType;
		const buffer = NormalNode.Normals.a;
		let indexBuffer = [];
		if (referenceType === "IndexToDirect") {
			if ("NormalIndex" in NormalNode) indexBuffer = NormalNode.NormalIndex.a;
			else if ("NormalsIndex" in NormalNode) indexBuffer = NormalNode.NormalsIndex.a;
		}
		return {
			dataSize: 3,
			buffer,
			indices: indexBuffer,
			mappingType,
			referenceType
		};
	}
	parseUVs(UVNode) {
		const mappingType = UVNode.MappingInformationType;
		const referenceType = UVNode.ReferenceInformationType;
		const buffer = UVNode.UV.a;
		let indexBuffer = [];
		if (referenceType === "IndexToDirect") indexBuffer = UVNode.UVIndex.a;
		return {
			dataSize: 2,
			buffer,
			indices: indexBuffer,
			mappingType,
			referenceType
		};
	}
	parseVertexColors(ColorNode) {
		const mappingType = ColorNode.MappingInformationType;
		const referenceType = ColorNode.ReferenceInformationType;
		const buffer = ColorNode.Colors.a;
		let indexBuffer = [];
		if (referenceType === "IndexToDirect") indexBuffer = ColorNode.ColorIndex.a;
		for (let i = 0, c = new Color(); i < buffer.length; i += 4) {
			c.fromArray(buffer, i);
			ColorManagement.colorSpaceToWorking(c, SRGBColorSpace);
			c.toArray(buffer, i);
		}
		return {
			dataSize: 4,
			buffer,
			indices: indexBuffer,
			mappingType,
			referenceType
		};
	}
	parseMaterialIndices(MaterialNode) {
		const mappingType = MaterialNode.MappingInformationType;
		const referenceType = MaterialNode.ReferenceInformationType;
		if (mappingType === "NoMappingInformation") return {
			dataSize: 1,
			buffer: [0],
			indices: [0],
			mappingType: "AllSame",
			referenceType
		};
		const materialIndexBuffer = MaterialNode.Materials.a;
		const materialIndices = [];
		for (let i = 0; i < materialIndexBuffer.length; ++i) materialIndices.push(i);
		return {
			dataSize: 1,
			buffer: materialIndexBuffer,
			indices: materialIndices,
			mappingType,
			referenceType
		};
	}
	parseNurbsGeometry(geoNode) {
		const order = parseInt(geoNode.Order);
		if (isNaN(order)) {
			console.error("THREE.FBXLoader: Invalid Order %s given for geometry ID: %s", geoNode.Order, geoNode.id);
			return new BufferGeometry();
		}
		const degree = order - 1;
		const knots = geoNode.KnotVector.a;
		const controlPoints = [];
		const pointsValues = geoNode.Points.a;
		for (let i = 0, l = pointsValues.length; i < l; i += 4) controlPoints.push(new Vector4().fromArray(pointsValues, i));
		let startKnot, endKnot;
		if (geoNode.Form === "Closed") controlPoints.push(controlPoints[0]);
		else if (geoNode.Form === "Periodic") {
			startKnot = degree;
			endKnot = knots.length - 1 - startKnot;
			for (let i = 0; i < degree; ++i) controlPoints.push(controlPoints[i]);
		}
		const points = new NURBSCurve(degree, knots, controlPoints, startKnot, endKnot).getPoints(controlPoints.length * 12);
		return new BufferGeometry().setFromPoints(points);
	}
};
var AnimationParser = class {
	parse() {
		const animationClips = [];
		const rawClips = this.parseClips();
		if (rawClips !== void 0) for (const key in rawClips) {
			const rawClip = rawClips[key];
			const clip = this.addClip(rawClip);
			animationClips.push(clip);
		}
		return animationClips;
	}
	parseClips() {
		if (fbxTree.Objects.AnimationCurve === void 0) return void 0;
		const curveNodesMap = this.parseAnimationCurveNodes();
		this.parseAnimationCurves(curveNodesMap);
		const layersMap = this.parseAnimationLayers(curveNodesMap);
		return this.parseAnimStacks(layersMap);
	}
	parseAnimationCurveNodes() {
		const rawCurveNodes = fbxTree.Objects.AnimationCurveNode;
		const curveNodesMap = /* @__PURE__ */ new Map();
		for (const nodeID in rawCurveNodes) {
			const rawCurveNode = rawCurveNodes[nodeID];
			if (rawCurveNode.attrName.match(/S|R|T|DeformPercent/) !== null) {
				const curveNode = {
					id: rawCurveNode.id,
					attr: rawCurveNode.attrName,
					curves: {}
				};
				curveNodesMap.set(curveNode.id, curveNode);
			}
		}
		return curveNodesMap;
	}
	parseAnimationCurves(curveNodesMap) {
		const rawCurves = fbxTree.Objects.AnimationCurve;
		for (const nodeID in rawCurves) {
			const animationCurve = {
				id: rawCurves[nodeID].id,
				times: rawCurves[nodeID].KeyTime.a.map(convertFBXTimeToSeconds),
				values: rawCurves[nodeID].KeyValueFloat.a
			};
			const relationships = connections.get(animationCurve.id);
			if (relationships !== void 0) {
				const animationCurveID = relationships.parents[0].ID;
				const animationCurveRelationship = relationships.parents[0].relationship;
				if (animationCurveRelationship.match(/X/)) curveNodesMap.get(animationCurveID).curves["x"] = animationCurve;
				else if (animationCurveRelationship.match(/Y/)) curveNodesMap.get(animationCurveID).curves["y"] = animationCurve;
				else if (animationCurveRelationship.match(/Z/)) curveNodesMap.get(animationCurveID).curves["z"] = animationCurve;
				else if (animationCurveRelationship.match(/DeformPercent/) && curveNodesMap.has(animationCurveID)) curveNodesMap.get(animationCurveID).curves["morph"] = animationCurve;
			}
		}
	}
	parseAnimationLayers(curveNodesMap) {
		const rawLayers = fbxTree.Objects.AnimationLayer;
		const layersMap = /* @__PURE__ */ new Map();
		for (const nodeID in rawLayers) {
			const layerCurveNodes = [];
			const connection = connections.get(parseInt(nodeID));
			if (connection !== void 0) {
				connection.children.forEach(function(child, i) {
					if (curveNodesMap.has(child.ID)) {
						const curveNode = curveNodesMap.get(child.ID);
						if (curveNode.curves.x !== void 0 || curveNode.curves.y !== void 0 || curveNode.curves.z !== void 0) {
							if (layerCurveNodes[i] === void 0) {
								const filteredParents = connections.get(child.ID).parents.filter(function(parent) {
									return parent.relationship !== void 0;
								});
								if (filteredParents.length === 0) return;
								const modelID = filteredParents[0].ID;
								if (modelID !== void 0) {
									const rawModel = fbxTree.Objects.Model[modelID.toString()];
									if (rawModel === void 0) {
										console.warn("THREE.FBXLoader: Encountered a unused curve.", child);
										return;
									}
									const node = {
										modelName: rawModel.attrName ? PropertyBinding.sanitizeNodeName(rawModel.attrName) : "",
										ID: rawModel.id,
										initialPosition: [
											0,
											0,
											0
										],
										initialRotation: [
											0,
											0,
											0
										],
										initialScale: [
											1,
											1,
											1
										]
									};
									sceneGraph.traverse(function(child) {
										if (child.ID === rawModel.id) {
											node.transform = child.matrix;
											if (child.userData.transformData) {
												node.eulerOrder = child.userData.transformData.eulerOrder;
												if (child.userData.transformData.rotation) node.initialRotation = child.userData.transformData.rotation;
											}
										}
									});
									if (!node.transform) node.transform = new Matrix4();
									if ("PreRotation" in rawModel) node.preRotation = rawModel.PreRotation.value;
									if ("PostRotation" in rawModel) node.postRotation = rawModel.PostRotation.value;
									layerCurveNodes[i] = node;
								}
							}
							if (layerCurveNodes[i]) layerCurveNodes[i][curveNode.attr] = curveNode;
						} else if (curveNode.curves.morph !== void 0) {
							if (layerCurveNodes[i] === void 0) {
								const filteredParents = connections.get(child.ID).parents.filter(function(parent) {
									return parent.relationship !== void 0;
								});
								if (filteredParents.length === 0) return;
								const deformerID = filteredParents[0].ID;
								const morpherID = connections.get(deformerID).parents[0].ID;
								const geoID = connections.get(morpherID).parents[0].ID;
								const modelID = connections.get(geoID).parents[0].ID;
								const rawModel = fbxTree.Objects.Model[modelID];
								const node = {
									modelName: rawModel.attrName ? PropertyBinding.sanitizeNodeName(rawModel.attrName) : "",
									morphName: fbxTree.Objects.Deformer[deformerID].attrName
								};
								layerCurveNodes[i] = node;
							}
							layerCurveNodes[i][curveNode.attr] = curveNode;
						}
					}
				});
				layersMap.set(parseInt(nodeID), layerCurveNodes);
			}
		}
		return layersMap;
	}
	parseAnimStacks(layersMap) {
		const rawStacks = fbxTree.Objects.AnimationStack;
		const rawClips = {};
		for (const nodeID in rawStacks) {
			const children = connections.get(parseInt(nodeID)).children;
			if (children.length > 1) console.warn("THREE.FBXLoader: Encountered an animation stack with multiple layers, this is currently not supported. Ignoring subsequent layers.");
			const layer = layersMap.get(children[0].ID);
			rawClips[nodeID] = {
				name: rawStacks[nodeID].attrName,
				layer
			};
		}
		return rawClips;
	}
	addClip(rawClip) {
		let tracks = [];
		const scope = this;
		rawClip.layer.forEach(function(rawTracks) {
			tracks = tracks.concat(scope.generateTracks(rawTracks));
		});
		return new AnimationClip(rawClip.name, -1, tracks);
	}
	generateTracks(rawTracks) {
		const tracks = [];
		let initialPosition = new Vector3();
		let initialScale = new Vector3();
		if (rawTracks.transform) rawTracks.transform.decompose(initialPosition, new Quaternion(), initialScale);
		initialPosition = initialPosition.toArray();
		initialScale = initialScale.toArray();
		if (rawTracks.T !== void 0 && Object.keys(rawTracks.T.curves).length > 0) {
			const positionTrack = this.generateVectorTrack(rawTracks.modelName, rawTracks.T.curves, initialPosition, "position");
			if (positionTrack !== void 0) tracks.push(positionTrack);
		}
		if (rawTracks.R !== void 0 && Object.keys(rawTracks.R.curves).length > 0) {
			const rotationTrack = this.generateRotationTrack(rawTracks.modelName, rawTracks.R.curves, rawTracks.preRotation, rawTracks.postRotation, rawTracks.eulerOrder, rawTracks.initialRotation);
			if (rotationTrack !== void 0) tracks.push(rotationTrack);
		}
		if (rawTracks.S !== void 0 && Object.keys(rawTracks.S.curves).length > 0) {
			const scaleTrack = this.generateVectorTrack(rawTracks.modelName, rawTracks.S.curves, initialScale, "scale");
			if (scaleTrack !== void 0) tracks.push(scaleTrack);
		}
		if (rawTracks.DeformPercent !== void 0) {
			const morphTrack = this.generateMorphTrack(rawTracks);
			if (morphTrack !== void 0) tracks.push(morphTrack);
		}
		return tracks;
	}
	generateVectorTrack(modelName, curves, initialValue, type) {
		const times = this.getTimesForAllAxes(curves);
		const values = this.getKeyframeTrackValues(times, curves, initialValue);
		return new VectorKeyframeTrack(modelName + "." + type, times, values);
	}
	generateRotationTrack(modelName, curves, preRotation, postRotation, eulerOrder, initialRotation) {
		let times;
		let values;
		if (curves.x !== void 0 || curves.y !== void 0 || curves.z !== void 0) {
			const mergedTimes = this.getTimesForAllAxes(curves);
			if (mergedTimes.length > 0) {
				const initialRot = initialRotation || [
					0,
					0,
					0
				];
				const syncX = this.synchronizeCurve(curves.x, mergedTimes, initialRot[0]);
				const syncY = this.synchronizeCurve(curves.y, mergedTimes, initialRot[1]);
				const syncZ = this.synchronizeCurve(curves.z, mergedTimes, initialRot[2]);
				const result = this.interpolateRotations(syncX, syncY, syncZ, eulerOrder);
				times = result[0];
				values = result[1];
			}
		}
		const defaultEulerOrder = getEulerOrder(0);
		if (preRotation !== void 0) {
			preRotation = preRotation.map(MathUtils.degToRad);
			preRotation.push(defaultEulerOrder);
			preRotation = new Euler().fromArray(preRotation);
			preRotation = new Quaternion().setFromEuler(preRotation);
		}
		if (postRotation !== void 0) {
			postRotation = postRotation.map(MathUtils.degToRad);
			postRotation.push(defaultEulerOrder);
			postRotation = new Euler().fromArray(postRotation);
			postRotation = new Quaternion().setFromEuler(postRotation).invert();
		}
		const quaternion = new Quaternion();
		const euler = new Euler();
		const quaternionValues = [];
		if (!values || !times) return void 0;
		for (let i = 0; i < values.length; i += 3) {
			euler.set(values[i], values[i + 1], values[i + 2], eulerOrder);
			quaternion.setFromEuler(euler);
			if (preRotation !== void 0) quaternion.premultiply(preRotation);
			if (postRotation !== void 0) quaternion.multiply(postRotation);
			if (i > 2) {
				if (new Quaternion().fromArray(quaternionValues, (i - 3) / 3 * 4).dot(quaternion) < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
			}
			quaternion.toArray(quaternionValues, i / 3 * 4);
		}
		return new QuaternionKeyframeTrack(modelName + ".quaternion", times, quaternionValues);
	}
	generateMorphTrack(rawTracks) {
		const curves = rawTracks.DeformPercent.curves.morph;
		const values = curves.values.map(function(val) {
			return val / 100;
		});
		const morphNum = sceneGraph.getObjectByName(rawTracks.modelName).morphTargetDictionary[rawTracks.morphName];
		return new NumberKeyframeTrack(rawTracks.modelName + ".morphTargetInfluences[" + morphNum + "]", curves.times, values);
	}
	getTimesForAllAxes(curves) {
		let times = [];
		if (curves.x !== void 0) times = times.concat(curves.x.times);
		if (curves.y !== void 0) times = times.concat(curves.y.times);
		if (curves.z !== void 0) times = times.concat(curves.z.times);
		times = times.sort(function(a, b) {
			return a - b;
		});
		if (times.length > 1) {
			let targetIndex = 1;
			let lastValue = times[0];
			for (let i = 1; i < times.length; i++) {
				const currentValue = times[i];
				if (currentValue !== lastValue) {
					times[targetIndex] = currentValue;
					lastValue = currentValue;
					targetIndex++;
				}
			}
			times = times.slice(0, targetIndex);
		}
		return times;
	}
	getKeyframeTrackValues(times, curves, initialValue) {
		const prevValue = initialValue;
		const values = [];
		let xIndex = -1;
		let yIndex = -1;
		let zIndex = -1;
		times.forEach(function(time) {
			if (curves.x) xIndex = curves.x.times.indexOf(time);
			if (curves.y) yIndex = curves.y.times.indexOf(time);
			if (curves.z) zIndex = curves.z.times.indexOf(time);
			if (xIndex !== -1) {
				const xValue = curves.x.values[xIndex];
				values.push(xValue);
				prevValue[0] = xValue;
			} else values.push(prevValue[0]);
			if (yIndex !== -1) {
				const yValue = curves.y.values[yIndex];
				values.push(yValue);
				prevValue[1] = yValue;
			} else values.push(prevValue[1]);
			if (zIndex !== -1) {
				const zValue = curves.z.values[zIndex];
				values.push(zValue);
				prevValue[2] = zValue;
			} else values.push(prevValue[2]);
		});
		return values;
	}
	synchronizeCurve(curve, targetTimes, initialValue) {
		if (curve === void 0) return {
			times: targetTimes,
			values: targetTimes.map(() => initialValue)
		};
		if (curve.times.length === targetTimes.length) return curve;
		const values = [];
		for (let i = 0; i < targetTimes.length; i++) values.push(this.sampleCurveValue(curve, targetTimes[i], initialValue));
		return {
			times: targetTimes,
			values
		};
	}
	sampleCurveValue(curve, time, initialValue) {
		const times = curve.times;
		const values = curve.values;
		if (time <= times[0]) return values[0];
		if (time >= times[times.length - 1]) return values[values.length - 1];
		for (let i = 0; i < times.length - 1; i++) if (time >= times[i] && time <= times[i + 1]) {
			if (times[i] === time) return values[i];
			const alpha = (time - times[i]) / (times[i + 1] - times[i]);
			return values[i] * (1 - alpha) + values[i + 1] * alpha;
		}
		return initialValue;
	}
	interpolateRotations(curvex, curvey, curvez, eulerOrder) {
		const times = [];
		const values = [];
		times.push(curvex.times[0]);
		values.push(MathUtils.degToRad(curvex.values[0]));
		values.push(MathUtils.degToRad(curvey.values[0]));
		values.push(MathUtils.degToRad(curvez.values[0]));
		for (let i = 1; i < curvex.values.length; i++) {
			const initialValue = [
				curvex.values[i - 1],
				curvey.values[i - 1],
				curvez.values[i - 1]
			];
			if (isNaN(initialValue[0]) || isNaN(initialValue[1]) || isNaN(initialValue[2])) continue;
			const initialValueRad = initialValue.map(MathUtils.degToRad);
			const currentValue = [
				curvex.values[i],
				curvey.values[i],
				curvez.values[i]
			];
			if (isNaN(currentValue[0]) || isNaN(currentValue[1]) || isNaN(currentValue[2])) continue;
			const currentValueRad = currentValue.map(MathUtils.degToRad);
			const valuesSpan = [
				currentValue[0] - initialValue[0],
				currentValue[1] - initialValue[1],
				currentValue[2] - initialValue[2]
			];
			const absoluteSpan = [
				Math.abs(valuesSpan[0]),
				Math.abs(valuesSpan[1]),
				Math.abs(valuesSpan[2])
			];
			if (absoluteSpan[0] >= 180 || absoluteSpan[1] >= 180 || absoluteSpan[2] >= 180) {
				const numSubIntervals = Math.max(...absoluteSpan) / 180;
				const E1 = new Euler(...initialValueRad, eulerOrder);
				const E2 = new Euler(...currentValueRad, eulerOrder);
				const Q1 = new Quaternion().setFromEuler(E1);
				const Q2 = new Quaternion().setFromEuler(E2);
				if (Q1.dot(Q2) < 0) Q2.set(-Q2.x, -Q2.y, -Q2.z, -Q2.w);
				const initialTime = curvex.times[i - 1];
				const timeSpan = curvex.times[i] - initialTime;
				const Q = new Quaternion();
				const E = new Euler();
				for (let t = 0; t < 1; t += 1 / numSubIntervals) {
					Q.copy(Q1.clone().slerp(Q2.clone(), t));
					times.push(initialTime + t * timeSpan);
					E.setFromQuaternion(Q, eulerOrder);
					values.push(E.x);
					values.push(E.y);
					values.push(E.z);
				}
			} else {
				times.push(curvex.times[i]);
				values.push(MathUtils.degToRad(curvex.values[i]));
				values.push(MathUtils.degToRad(curvey.values[i]));
				values.push(MathUtils.degToRad(curvez.values[i]));
			}
		}
		return [times, values];
	}
};
var TextParser = class {
	getPrevNode() {
		return this.nodeStack[this.currentIndent - 2];
	}
	getCurrentNode() {
		return this.nodeStack[this.currentIndent - 1];
	}
	getCurrentProp() {
		return this.currentProp;
	}
	pushStack(node) {
		this.nodeStack.push(node);
		this.currentIndent += 1;
	}
	popStack() {
		this.nodeStack.pop();
		this.currentIndent -= 1;
	}
	setCurrentProp(val, name) {
		this.currentProp = val;
		this.currentPropName = name;
	}
	parse(text) {
		this.currentIndent = 0;
		this.allNodes = new FBXTree();
		this.nodeStack = [];
		this.currentProp = [];
		this.currentPropName = "";
		const scope = this;
		const split = text.split(/[\r\n]+/);
		split.forEach(function(line, i) {
			const matchComment = line.match(/^[\s\t]*;/);
			const matchEmpty = line.match(/^[\s\t]*$/);
			if (matchComment || matchEmpty) return;
			const matchBeginning = line.match("^\\t{" + scope.currentIndent + "}(\\w+):(.*){", "");
			const matchProperty = line.match("^\\t{" + scope.currentIndent + "}(\\w+):[\\s\\t\\r\\n](.*)");
			const matchEnd = line.match("^\\t{" + (scope.currentIndent - 1) + "}}");
			if (matchBeginning) scope.parseNodeBegin(line, matchBeginning);
			else if (matchProperty) scope.parseNodeProperty(line, matchProperty, split[++i]);
			else if (matchEnd) scope.popStack();
			else if (line.match(/^[^\s\t}]/)) scope.parseNodePropertyContinued(line);
		});
		return this.allNodes;
	}
	parseNodeBegin(line, property) {
		const nodeName = property[1].trim().replace(/^"/, "").replace(/"$/, "");
		const nodeAttrs = property[2].split(",").map(function(attr) {
			return attr.trim().replace(/^"/, "").replace(/"$/, "");
		});
		const node = { name: nodeName };
		const attrs = this.parseNodeAttr(nodeAttrs);
		const currentNode = this.getCurrentNode();
		if (this.currentIndent === 0) this.allNodes.add(nodeName, node);
		else if (nodeName in currentNode) {
			if (nodeName === "PoseNode") currentNode.PoseNode.push(node);
			else if (currentNode[nodeName].id !== void 0) {
				currentNode[nodeName] = {};
				currentNode[nodeName][currentNode[nodeName].id] = currentNode[nodeName];
			}
			if (attrs.id !== "") currentNode[nodeName][attrs.id] = node;
		} else if (typeof attrs.id === "number") {
			currentNode[nodeName] = {};
			currentNode[nodeName][attrs.id] = node;
		} else if (nodeName !== "Properties70") if (nodeName === "PoseNode") currentNode[nodeName] = [node];
		else currentNode[nodeName] = node;
		if (typeof attrs.id === "number") node.id = attrs.id;
		if (attrs.name !== "") node.attrName = attrs.name;
		if (attrs.type !== "") node.attrType = attrs.type;
		this.pushStack(node);
	}
	parseNodeAttr(attrs) {
		let id = attrs[0];
		if (attrs[0] !== "") {
			id = parseInt(attrs[0]);
			if (isNaN(id)) id = attrs[0];
		}
		let name = "", type = "";
		if (attrs.length > 1) {
			name = attrs[1].replace(/^(\w+)::/, "");
			type = attrs[2];
		}
		return {
			id,
			name,
			type
		};
	}
	parseNodeProperty(line, property, contentLine) {
		let propName = property[1].replace(/^"/, "").replace(/"$/, "").trim();
		let propValue = property[2].replace(/^"/, "").replace(/"$/, "").trim();
		if (propName === "Content" && propValue === ",") propValue = contentLine.replace(/"/g, "").replace(/,$/, "").trim();
		const currentNode = this.getCurrentNode();
		if (currentNode.name === "Properties70") {
			this.parseNodeSpecialProperty(line, propName, propValue);
			return;
		}
		if (propName === "C") {
			const connProps = propValue.split(",").slice(1);
			const from = parseInt(connProps[0]);
			const to = parseInt(connProps[1]);
			let rest = propValue.split(",").slice(3);
			rest = rest.map(function(elem) {
				return elem.trim().replace(/^"/, "");
			});
			propName = "connections";
			propValue = [from, to];
			append(propValue, rest);
			if (currentNode[propName] === void 0) currentNode[propName] = [];
		}
		if (propName === "Node") currentNode.id = propValue;
		if (propName in currentNode && Array.isArray(currentNode[propName])) currentNode[propName].push(propValue);
		else if (propName !== "a") currentNode[propName] = propValue;
		else currentNode.a = propValue;
		this.setCurrentProp(currentNode, propName);
		if (propName === "a" && propValue.slice(-1) !== ",") currentNode.a = parseNumberArray(propValue);
	}
	parseNodePropertyContinued(line) {
		const currentNode = this.getCurrentNode();
		currentNode.a += line;
		if (line.slice(-1) !== ",") currentNode.a = parseNumberArray(currentNode.a);
	}
	parseNodeSpecialProperty(line, propName, propValue) {
		const props = propValue.split("\",").map(function(prop) {
			return prop.trim().replace(/^\"/, "").replace(/\s/, "_");
		});
		const innerPropName = props[0];
		const innerPropType1 = props[1];
		const innerPropType2 = props[2];
		const innerPropFlag = props[3];
		let innerPropValue = props[4];
		switch (innerPropType1) {
			case "int":
			case "enum":
			case "bool":
			case "ULongLong":
			case "double":
			case "Number":
			case "FieldOfView":
				innerPropValue = parseFloat(innerPropValue);
				break;
			case "Color":
			case "ColorRGB":
			case "Vector3D":
			case "Lcl_Translation":
			case "Lcl_Rotation":
			case "Lcl_Scaling": innerPropValue = parseNumberArray(innerPropValue);
		}
		this.getPrevNode()[innerPropName] = {
			"type": innerPropType1,
			"type2": innerPropType2,
			"flag": innerPropFlag,
			"value": innerPropValue
		};
		this.setCurrentProp(this.getPrevNode(), innerPropName);
	}
};
var BinaryParser = class {
	parse(buffer) {
		const reader = new BinaryReader(buffer);
		reader.skip(23);
		const version = reader.getUint32();
		if (version < 6400) throw new Error("THREE.FBXLoader: FBX version not supported, FileVersion: " + version);
		const allNodes = new FBXTree();
		while (!this.endOfContent(reader)) {
			const node = this.parseNode(reader, version);
			if (node !== null) allNodes.add(node.name, node);
		}
		return allNodes;
	}
	endOfContent(reader) {
		if (reader.size() % 16 === 0) return (reader.getOffset() + 160 + 16 & -16) >= reader.size();
		else return reader.getOffset() + 160 + 16 >= reader.size();
	}
	parseNode(reader, version) {
		const node = {};
		const endOffset = version >= 7500 ? reader.getUint64() : reader.getUint32();
		const numProperties = version >= 7500 ? reader.getUint64() : reader.getUint32();
		version >= 7500 ? reader.getUint64() : reader.getUint32();
		const nameLen = reader.getUint8();
		const name = reader.getString(nameLen);
		if (endOffset === 0) return null;
		const propertyList = [];
		for (let i = 0; i < numProperties; i++) propertyList.push(this.parseProperty(reader));
		const id = propertyList.length > 0 ? propertyList[0] : "";
		const attrName = propertyList.length > 1 ? propertyList[1] : "";
		const attrType = propertyList.length > 2 ? propertyList[2] : "";
		node.singleProperty = numProperties === 1 && reader.getOffset() === endOffset ? true : false;
		while (endOffset > reader.getOffset()) {
			const subNode = this.parseNode(reader, version);
			if (subNode !== null) this.parseSubNode(name, node, subNode);
		}
		node.propertyList = propertyList;
		if (typeof id === "number") node.id = id;
		if (attrName !== "") node.attrName = attrName;
		if (attrType !== "") node.attrType = attrType;
		if (name !== "") node.name = name;
		return node;
	}
	parseSubNode(name, node, subNode) {
		if (subNode.singleProperty === true) {
			const value = subNode.propertyList[0];
			if (Array.isArray(value)) {
				node[subNode.name] = subNode;
				subNode.a = value;
			} else node[subNode.name] = value;
		} else if (name === "Connections" && subNode.name === "C") {
			const array = [];
			subNode.propertyList.forEach(function(property, i) {
				if (i !== 0) array.push(property);
			});
			if (node.connections === void 0) node.connections = [];
			node.connections.push(array);
		} else if (subNode.name === "Properties70") Object.keys(subNode).forEach(function(key) {
			node[key] = subNode[key];
		});
		else if (name === "Properties70" && subNode.name === "P") {
			let innerPropName = subNode.propertyList[0];
			let innerPropType1 = subNode.propertyList[1];
			const innerPropType2 = subNode.propertyList[2];
			const innerPropFlag = subNode.propertyList[3];
			let innerPropValue;
			if (innerPropName.indexOf("Lcl ") === 0) innerPropName = innerPropName.replace("Lcl ", "Lcl_");
			if (innerPropType1.indexOf("Lcl ") === 0) innerPropType1 = innerPropType1.replace("Lcl ", "Lcl_");
			if (innerPropType1 === "Color" || innerPropType1 === "ColorRGB" || innerPropType1 === "Vector" || innerPropType1 === "Vector3D" || innerPropType1.indexOf("Lcl_") === 0) innerPropValue = [
				subNode.propertyList[4],
				subNode.propertyList[5],
				subNode.propertyList[6]
			];
			else innerPropValue = subNode.propertyList[4];
			node[innerPropName] = {
				"type": innerPropType1,
				"type2": innerPropType2,
				"flag": innerPropFlag,
				"value": innerPropValue
			};
		} else if (node[subNode.name] === void 0) if (typeof subNode.id === "number") {
			node[subNode.name] = {};
			node[subNode.name][subNode.id] = subNode;
		} else node[subNode.name] = subNode;
		else if (subNode.name === "PoseNode") {
			if (!Array.isArray(node[subNode.name])) node[subNode.name] = [node[subNode.name]];
			node[subNode.name].push(subNode);
		} else if (node[subNode.name][subNode.id] === void 0) node[subNode.name][subNode.id] = subNode;
	}
	parseProperty(reader) {
		const type = reader.getString(1);
		let length;
		switch (type) {
			case "C": return reader.getBoolean();
			case "D": return reader.getFloat64();
			case "F": return reader.getFloat32();
			case "I": return reader.getInt32();
			case "L": return reader.getInt64();
			case "R":
				length = reader.getUint32();
				return reader.getArrayBuffer(length);
			case "S":
				length = reader.getUint32();
				return reader.getString(length);
			case "Y": return reader.getInt16();
			case "b":
			case "c":
			case "d":
			case "f":
			case "i":
			case "l":
				const arrayLength = reader.getUint32();
				const encoding = reader.getUint32();
				const compressedLength = reader.getUint32();
				if (encoding === 0) switch (type) {
					case "b":
					case "c": return reader.getBooleanArray(arrayLength);
					case "d": return reader.getFloat64Array(arrayLength);
					case "f": return reader.getFloat32Array(arrayLength);
					case "i": return reader.getInt32Array(arrayLength);
					case "l": return reader.getInt64Array(arrayLength);
				}
				const reader2 = new BinaryReader(unzlibSync(new Uint8Array(reader.getArrayBuffer(compressedLength))).buffer);
				switch (type) {
					case "b":
					case "c": return reader2.getBooleanArray(arrayLength);
					case "d": return reader2.getFloat64Array(arrayLength);
					case "f": return reader2.getFloat32Array(arrayLength);
					case "i": return reader2.getInt32Array(arrayLength);
					case "l": return reader2.getInt64Array(arrayLength);
				}
				break;
			default: throw new Error("THREE.FBXLoader: Unknown property type " + type);
		}
	}
};
var BinaryReader = class {
	constructor(buffer, littleEndian) {
		this.dv = new DataView(buffer);
		this.offset = 0;
		this.littleEndian = littleEndian !== void 0 ? littleEndian : true;
		this._textDecoder = new TextDecoder();
	}
	getOffset() {
		return this.offset;
	}
	size() {
		return this.dv.buffer.byteLength;
	}
	skip(length) {
		this.offset += length;
	}
	getBoolean() {
		return (this.getUint8() & 1) === 1;
	}
	getBooleanArray(size) {
		const a = [];
		for (let i = 0; i < size; i++) a.push(this.getBoolean());
		return a;
	}
	getUint8() {
		const value = this.dv.getUint8(this.offset);
		this.offset += 1;
		return value;
	}
	getInt16() {
		const value = this.dv.getInt16(this.offset, this.littleEndian);
		this.offset += 2;
		return value;
	}
	getInt32() {
		const value = this.dv.getInt32(this.offset, this.littleEndian);
		this.offset += 4;
		return value;
	}
	getInt32Array(size) {
		const a = [];
		for (let i = 0; i < size; i++) a.push(this.getInt32());
		return a;
	}
	getUint32() {
		const value = this.dv.getUint32(this.offset, this.littleEndian);
		this.offset += 4;
		return value;
	}
	getInt64() {
		let low, high;
		if (this.littleEndian) {
			low = this.getUint32();
			high = this.getUint32();
		} else {
			high = this.getUint32();
			low = this.getUint32();
		}
		if (high & 2147483648) {
			high = ~high & 4294967295;
			low = ~low & 4294967295;
			if (low === 4294967295) high = high + 1 & 4294967295;
			low = low + 1 & 4294967295;
			return -(high * 4294967296 + low);
		}
		return high * 4294967296 + low;
	}
	getInt64Array(size) {
		const a = [];
		for (let i = 0; i < size; i++) a.push(this.getInt64());
		return a;
	}
	getUint64() {
		let low, high;
		if (this.littleEndian) {
			low = this.getUint32();
			high = this.getUint32();
		} else {
			high = this.getUint32();
			low = this.getUint32();
		}
		return high * 4294967296 + low;
	}
	getFloat32() {
		const value = this.dv.getFloat32(this.offset, this.littleEndian);
		this.offset += 4;
		return value;
	}
	getFloat32Array(size) {
		const a = [];
		for (let i = 0; i < size; i++) a.push(this.getFloat32());
		return a;
	}
	getFloat64() {
		const value = this.dv.getFloat64(this.offset, this.littleEndian);
		this.offset += 8;
		return value;
	}
	getFloat64Array(size) {
		const a = [];
		for (let i = 0; i < size; i++) a.push(this.getFloat64());
		return a;
	}
	getArrayBuffer(size) {
		const value = this.dv.buffer.slice(this.offset, this.offset + size);
		this.offset += size;
		return value;
	}
	getString(size) {
		const start = this.offset;
		let a = new Uint8Array(this.dv.buffer, start, size);
		this.skip(size);
		const nullByte = a.indexOf(0);
		if (nullByte >= 0) a = new Uint8Array(this.dv.buffer, start, nullByte);
		return this._textDecoder.decode(a);
	}
};
var FBXTree = class {
	add(key, val) {
		this[key] = val;
	}
};
function isFbxFormatBinary(buffer) {
	return buffer.byteLength >= 21 && "Kaydara FBX Binary  \0" === convertArrayBufferToString(buffer, 0, 21);
}
function isFbxFormatASCII(text) {
	const CORRECT = [
		"K",
		"a",
		"y",
		"d",
		"a",
		"r",
		"a",
		"\\",
		"F",
		"B",
		"X",
		"\\",
		"B",
		"i",
		"n",
		"a",
		"r",
		"y",
		"\\",
		"\\"
	];
	let cursor = 0;
	function read(offset) {
		const result = text[offset - 1];
		text = text.slice(cursor + offset);
		cursor++;
		return result;
	}
	for (let i = 0; i < CORRECT.length; ++i) if (read(1) === CORRECT[i]) return false;
	return true;
}
function getFbxVersion(text) {
	const match = text.match(/FBXVersion: (\d+)/);
	if (match) return parseInt(match[1]);
	throw new Error("THREE.FBXLoader: Cannot find the version number for the file given.");
}
function convertFBXTimeToSeconds(time) {
	return time / 46186158e3;
}
var dataArray = [];
function getData(polygonVertexIndex, polygonIndex, vertexIndex, infoObject) {
	let index;
	switch (infoObject.mappingType) {
		case "ByPolygonVertex":
			index = polygonVertexIndex;
			break;
		case "ByPolygon":
			index = polygonIndex;
			break;
		case "ByVertice":
			index = vertexIndex;
			break;
		case "AllSame":
			index = infoObject.indices[0];
			break;
		default: console.warn("THREE.FBXLoader: unknown attribute mapping type " + infoObject.mappingType);
	}
	if (infoObject.referenceType === "IndexToDirect") index = infoObject.indices[index];
	const from = index * infoObject.dataSize;
	const to = from + infoObject.dataSize;
	return slice(dataArray, infoObject.buffer, from, to);
}
var tempEuler = new Euler();
var tempVec = new Vector3();
function generateTransform(transformData) {
	const lTranslationM = new Matrix4();
	const lPreRotationM = new Matrix4();
	const lRotationM = new Matrix4();
	const lPostRotationM = new Matrix4();
	const lScalingM = new Matrix4();
	const lScalingPivotM = new Matrix4();
	const lScalingOffsetM = new Matrix4();
	const lRotationOffsetM = new Matrix4();
	const lRotationPivotM = new Matrix4();
	const lParentGX = new Matrix4();
	const lParentLX = new Matrix4();
	const lGlobalT = new Matrix4();
	const inheritType = transformData.inheritType ? transformData.inheritType : 0;
	if (transformData.translation) lTranslationM.setPosition(tempVec.fromArray(transformData.translation));
	const defaultEulerOrder = getEulerOrder(0);
	if (transformData.preRotation) {
		const array = transformData.preRotation.map(MathUtils.degToRad);
		array.push(defaultEulerOrder);
		lPreRotationM.makeRotationFromEuler(tempEuler.fromArray(array));
	}
	if (transformData.rotation) {
		const array = transformData.rotation.map(MathUtils.degToRad);
		array.push(transformData.eulerOrder || defaultEulerOrder);
		lRotationM.makeRotationFromEuler(tempEuler.fromArray(array));
	}
	if (transformData.postRotation) {
		const array = transformData.postRotation.map(MathUtils.degToRad);
		array.push(defaultEulerOrder);
		lPostRotationM.makeRotationFromEuler(tempEuler.fromArray(array));
		lPostRotationM.invert();
	}
	if (transformData.scale) lScalingM.scale(tempVec.fromArray(transformData.scale));
	if (transformData.scalingOffset) lScalingOffsetM.setPosition(tempVec.fromArray(transformData.scalingOffset));
	if (transformData.scalingPivot) lScalingPivotM.setPosition(tempVec.fromArray(transformData.scalingPivot));
	if (transformData.rotationOffset) lRotationOffsetM.setPosition(tempVec.fromArray(transformData.rotationOffset));
	if (transformData.rotationPivot) lRotationPivotM.setPosition(tempVec.fromArray(transformData.rotationPivot));
	if (transformData.parentMatrixWorld) {
		lParentLX.copy(transformData.parentMatrix);
		lParentGX.copy(transformData.parentMatrixWorld);
	}
	const lLRM = lPreRotationM.clone().multiply(lRotationM).multiply(lPostRotationM);
	const lParentGRM = new Matrix4();
	lParentGRM.extractRotation(lParentGX);
	const lParentTM = new Matrix4();
	lParentTM.copyPosition(lParentGX);
	const lParentGRSM = lParentTM.clone().invert().multiply(lParentGX);
	const lParentGSM = lParentGRM.clone().invert().multiply(lParentGRSM);
	const lLSM = lScalingM;
	const lGlobalRS = new Matrix4();
	if (inheritType === 0) lGlobalRS.copy(lParentGRM).multiply(lLRM).multiply(lParentGSM).multiply(lLSM);
	else if (inheritType === 1) lGlobalRS.copy(lParentGRM).multiply(lParentGSM).multiply(lLRM).multiply(lLSM);
	else {
		const lParentLSM_inv = new Matrix4().scale(new Vector3().setFromMatrixScale(lParentLX)).clone().invert();
		const lParentGSM_noLocal = lParentGSM.clone().multiply(lParentLSM_inv);
		lGlobalRS.copy(lParentGRM).multiply(lLRM).multiply(lParentGSM_noLocal).multiply(lLSM);
	}
	const lRotationPivotM_inv = lRotationPivotM.clone().invert();
	const lScalingPivotM_inv = lScalingPivotM.clone().invert();
	let lTransform = lTranslationM.clone().multiply(lRotationOffsetM).multiply(lRotationPivotM).multiply(lPreRotationM).multiply(lRotationM).multiply(lPostRotationM).multiply(lRotationPivotM_inv).multiply(lScalingOffsetM).multiply(lScalingPivotM).multiply(lScalingM).multiply(lScalingPivotM_inv);
	const lLocalTWithAllPivotAndOffsetInfo = new Matrix4().copyPosition(lTransform);
	const lGlobalTranslation = lParentGX.clone().multiply(lLocalTWithAllPivotAndOffsetInfo);
	lGlobalT.copyPosition(lGlobalTranslation);
	lTransform = lGlobalT.clone().multiply(lGlobalRS);
	lTransform.premultiply(lParentGX.invert());
	return lTransform;
}
function getEulerOrder(order) {
	order = order || 0;
	const enums = [
		"ZYX",
		"YZX",
		"XZY",
		"ZXY",
		"YXZ",
		"XYZ"
	];
	if (order === 6) {
		console.warn("THREE.FBXLoader: unsupported Euler Order: Spherical XYZ. Animations and rotations may be incorrect.");
		return enums[0];
	}
	return enums[order];
}
function parseNumberArray(value) {
	return value.split(",").map(function(val) {
		return parseFloat(val);
	});
}
function convertArrayBufferToString(buffer, from, to) {
	if (from === void 0) from = 0;
	if (to === void 0) to = buffer.byteLength;
	return new TextDecoder().decode(new Uint8Array(buffer, from, to));
}
function append(a, b) {
	for (let i = 0, j = a.length, l = b.length; i < l; i++, j++) a[j] = b[i];
}
function slice(a, b, from, to) {
	for (let i = from, j = 0; i < to; i++, j++) a[j] = b[i];
	return a;
}
//#endregion
export { FBXLoader };
