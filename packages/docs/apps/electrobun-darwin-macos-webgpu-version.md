---
title: "Darwin vs macOS version (Electrobun WebGPU)"
sidebarTitle: "Darwin / macOS WebGPU"
description: "Why Node’s os.release() reports Darwin, not macOS marketing major, and how Eliza maps the two so WKWebView WebGPU gating stays correct after macOS 26 (Tahoe)."
---

# Darwin vs macOS marketing version (Electrobun WebGPU gate)

Electrobun’s main process uses **`os.release()`** (same family as **`uname -r`**) to decide whether **WKWebView** is expected to expose **`navigator.gpu`** on macOS. That string is a **Darwin kernel major**, not the **macOS marketing major** shown in **About This Mac** (e.g. “macOS Tahoe 26.2”).

This page explains **why** a naive formula misclassified Tahoe users, **what** mapping we use instead, and **where** the code and tests live.

## Problem we were solving

### Symptom

Logs showed a **misleading macOS major** in the WebGPU status line (e.g. treating Darwin 25 as “macOS 16”) so the message looked like the OS was too old, even on **macOS 26.x** with **`uname -r`** in the **25.x** range. Current builds use corrected Darwin→marketing mapping and clarify that **Eliza still runs on WebGL** when WKWebView has no WebGPU; the line is **not** “the app is unsupported.”

### Root cause

For years, **macOS 11–15** paired with **Darwin 20–24** such that:

**macOS marketing major ≈ Darwin major − 9**  
(e.g. Darwin **24** → macOS **15** Sequoia).

Starting with **macOS 26 (Tahoe)**, Apple kept **Darwin at 25** for that release: build numbers and the kernel version string still start with **25**, while the **product** major is **26**. **Why Apple did this:** Darwin’s major is tied to its own release train and build numbering; Tahoe aligned **platform marketing versions** (macOS / iOS 26, etc.) without bumping Darwin to 26 for that cycle. See [Rich Trouton — why macOS 26 build numbers begin with 25](https://derflounder.wordpress.com/2025/12/24/why-macos-26-build-numbers-begin-with-25/).

So the old single rule **`Darwin − 9`** on Darwin **25** produced **16**, which is **wrong** for both the user-visible OS name and our **“≥ 26 for native WKWebView WebGPU”** gate.

**Why that gate exists:** we only want to claim **native WebGPU in WKWebView** when the OS/WebKit stack is known to support it; otherwise we point people at **Chrome Beta** and accurate messaging. Wrong mapping broke trust and feature detection.

## Decision / mapping

We use a **two-segment** mapping, matching Apple’s published Darwin release table (e.g. [Wikipedia — Darwin (operating system), § Darwin 20 onwards](https://en.wikipedia.org/wiki/Darwin_(operating_system))):

| Darwin major | macOS marketing major |
|-------------:|----------------------:|
| 20 | 11 |
| 21 | 12 |
| 22 | 13 |
| 23 | 14 |
| 24 | 15 |
| 25 | **26** (Tahoe) |

**Rules in code:**

- **Darwin 20–24:** `macOS_major = Darwin_major − 9`
- **Darwin ≥ 25:** `macOS_major = Darwin_major + 1`  
  (so Darwin **25** → **26**; Darwin **26** → **27** when that ships, unless Apple changes scheme again)

**Darwin majors below 20** (macOS 10.x era): we return **`null`**. **Why:** those releases are still “macOS 10” with a **minor** version; a single integer “marketing major” in the 11+ sense does not apply the same way, and WebGPU in this path is irrelevant.

## Where in the repo

| Piece | Location |
|--------|----------|
| Mapping + `checkWebGpuSupport` | `apps/app/electrobun/src/native/webgpu-browser-support.ts` |
| Vitest | `apps/app/electrobun/src/native/__tests__/webgpu-browser-support.test.ts` |
| Startup log / browser surface | `apps/app/electrobun/src/index.ts` (search `WebGPU Browser`) |

## Maintenance note

If Apple ever **changes** the Darwin ↔ macOS relationship again, update **`getMacOSMajorVersion()`**, this doc, and the **Vitest table** together. **Why:** silent drift here shows up as wrong user-facing strings and wrong capability gates, not as type errors.
