#!/usr/bin/env node
/**
 * Preview the basic-capabilities banner with ANSI colors.
 * Run from repo root: node packages/core/scripts/preview-banner.mjs
 */
const c = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	dim: "\x1b[2m",
	brightBlue: "\x1b[94m",
	brightCyan: "\x1b[96m",
	yellow: "\x1b[33m",
};

const sym = [
	"  ___  ",
	" |   | ",
	" | | | ",
	" |___| ",
	"   |   ",
	"   |   ",
].map((line) => `${c.yellow}${line}${c.reset}`);

const artLines = [
	["    ____              __       __                        ", sym[0]],
	["   / __ )____  ____  / /______/ /__________ _____       ", sym[1]],
	["  / __  / __ \\/ __ \\/ __/ ___/ __/ ___/ __ '/ __ \\     ", sym[2]],
	[" / /_/ / /_/ / /_/ / /_(__  ) /_/ /  / /_/ / /_/ /     ", sym[3]],
	["/_____/\\____/\\____/\\__/____/\\__/_/   \\__,_/ .___/     ", sym[4]],
	["                                             \\__/     ", sym[5]],
];

const border = `${c.bright}${c.brightBlue}+${"-".repeat(78)}+${c.reset}`;
const pipe = `${c.bright}${c.brightBlue}|${c.reset}`;

function isFullWidth(code) {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		code === 0x231a ||
		code === 0x231b ||
		(code >= 0x23e9 && code <= 0x23f3) ||
		code === 0x23f0 ||
		code === 0x2614 ||
		code === 0x2615 ||
		(code >= 0x2648 && code <= 0x2653) ||
		code === 0x267f ||
		code === 0x2693 ||
		code === 0x26a1 ||
		code === 0x26aa ||
		code === 0x26ab ||
		code === 0x26bd ||
		code === 0x26be ||
		code === 0x26c4 ||
		code === 0x26c5 ||
		code === 0x26ce ||
		code === 0x26d4 ||
		code === 0x26ea ||
		code === 0x26f2 ||
		code === 0x26f3 ||
		code === 0x26f5 ||
		code === 0x26fa ||
		code === 0x26fd ||
		code === 0x2702 ||
		code === 0x2705 ||
		(code >= 0x2708 && code <= 0x270d) ||
		code === 0x270f ||
		code === 0x2712 ||
		code === 0x2714 ||
		code === 0x2716 ||
		code === 0x271d ||
		code === 0x2721 ||
		code === 0x2728 ||
		(code >= 0x2733 && code <= 0x2734) ||
		code === 0x2744 ||
		code === 0x2747 ||
		code === 0x274c ||
		code === 0x274e ||
		(code >= 0x2753 && code <= 0x2755) ||
		code === 0x2757 ||
		(code >= 0x2763 && code <= 0x2764) ||
		(code >= 0x2795 && code <= 0x2797) ||
		code === 0x27a1 ||
		code === 0x27b0 ||
		code === 0x27bf ||
		(code >= 0x2934 && code <= 0x2935) ||
		(code >= 0x2b05 && code <= 0x2b07) ||
		(code >= 0x2b1b && code <= 0x2b1c) ||
		code === 0x2b50 ||
		code === 0x2b55 ||
		code === 0x3030 ||
		code === 0x303d ||
		code === 0x3297 ||
		code === 0x3299 ||
		(code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
		(code >= 0x3250 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0xa4c6) ||
		(code >= 0xa960 && code <= 0xa97c) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6b) ||
		(code >= 0xff01 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f000 && code <= 0x1fbff) ||
		(code >= 0x20000 && code <= 0x323af)
	);
}

function graphemeWidth(grapheme) {
	const code = grapheme.codePointAt(0) ?? 0;
	if (grapheme.length > 2) return 2;
	return isFullWidth(code) ? 2 : 1;
}

function displayWidth(text) {
	const ansiRe = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
	const stripped = text.replace(ansiRe, "");
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	let width = 0;
	for (const { segment } of segmenter.segment(stripped)) {
		width += graphemeWidth(segment);
	}
	return width;
}

function artLine(cyanText, symPart, suffix = "") {
	const used =
		displayWidth(cyanText) + displayWidth(symPart) + displayWidth(suffix);
	const pad = Math.max(0, 78 - used);
	return `${pipe}${c.brightCyan}${cyanText}${c.reset}${symPart}${suffix}${" ".repeat(pad)}${pipe}`;
}

const artContent = [
	artLine(artLines[0][0], artLines[0][1]),
	artLine(artLines[1][0], artLines[1][1]),
	artLine(artLines[2][0], artLines[2][1]),
	artLine(artLines[3][0], artLines[3][1]),
	artLine(artLines[4][0], artLines[4][1]),
	artLine(artLines[5][0], artLines[5][1], `${c.dim}plugin${c.reset}`),
].join("\n");

console.log(`\n${border}\n${artContent}\n${border}\n`);
