type Msg = { from: "bot" | "user"; text: string };

const imessageMessages: Msg[] = [
  { from: "bot", text: "good morning! what's on the agenda today?" },
  { from: "user", text: "ugh too much. can you sort out my calendar?" },
  {
    from: "bot",
    text: "done. moved your 2pm to thursday and blocked focus time at 3",
  },
  {
    from: "user",
    text: "that works. also what's a good gift for my mom's birthday?",
  },
  {
    from: "bot",
    text: "she mentioned wanting a new cookbook last week. want me to find one and have it wrapped?",
  },
];

const telegramMessages: Msg[] = [
  { from: "user", text: "what's the weather like this weekend?" },
  {
    from: "bot",
    text: "saturday sunny 72°, sunday partly cloudy 68°. great for outdoors!",
  },
  { from: "user", text: "nice. find me a good brunch spot nearby" },
  {
    from: "bot",
    text: "the corner bistro has a 4.8 rating and is 5 min away. want me to book?",
  },
  { from: "user", text: "yes! table for two at noon" },
  { from: "bot", text: "booked! confirmation sent to your email 🎉" },
];

function getMessages(): Msg[] {
  if (currentRenderPlatform === "telegram") return telegramMessages;
  if (currentRenderPlatform === "imessage") return imessageMessages;
  console.warn(
    "[renderChatToCanvas] Unsupported render platform:",
    currentRenderPlatform,
    "- falling back to iMessage messages.",
  );
  return imessageMessages;
}

export function getMessageCount(): number {
  return getMessages().length;
}

export function measurePreloadedScrollHeight(count: number): number {
  const msgs = getMessages();
  const n = Math.min(count, msgs.length);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += measureBubbleHeight(msgs[i].text);
  }
  // measureBubbleHeight already includes one gap per bubble,
  // but between N bubbles there are only N-1 gaps, so subtract one.
  if (n > 1) {
    total -= s(10) / SCALE;
  }
  return total;
}

export const MESSAGE_COUNT = imessageMessages.length;

export interface ExtraMessage {
  text: string;
  progress: number;
  from: "bot" | "user";
  typing?: boolean;
}

export const TYPING_BUBBLE_HEIGHT = 50;

let currentRenderPlatform = "imessage";
export function setChatPlatform(p: string) {
  currentRenderPlatform = p;
}
export function getChatPlatform() {
  return currentRenderPlatform;
}

let wallpaperImg: HTMLImageElement | null = null;
let tgBgImg: HTMLImageElement | null = null;
if (typeof window !== "undefined") {
  wallpaperImg = new Image();
  wallpaperImg.src = "/elizawallpaper.jpeg";
  tgBgImg = new Image();
  tgBgImg.src = "/tbg.jpg";
}

const SCALE = 4;
const W = 390 * SCALE;
const H = 844 * SCALE;

// Button overlay constants (canvas pixels)
// Back button is a pill — export its left edge, center-Y, width, height
export const BACK_BTN_X = 17 * SCALE;
export const BACK_BTN_CY = 59 * SCALE + 15 * SCALE;
export const BACK_BTN_H = 40 * SCALE;
// Width is computed at runtime (depends on font metrics), so we export a close estimate
export const BACK_BTN_W_ESTIMATE = 380;
// Video button remains a circle
export const VID_BTN_CX = W - 37 * SCALE;
export const VID_BTN_CY = 59 * SCALE + 15 * SCALE;
export const CANVAS_W = W;
export const CANVAS_H = H;

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  ctx.lineTo(x + bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
  ctx.lineTo(x, y + tl);
  ctx.quadraticCurveTo(x, y, x + tl, y);
  ctx.closePath();
}

function pill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const r = h / 2;
  roundRect(ctx, x, y, w, h, r, r, r, r);
}

function iMessageBubble(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  isUser: boolean,
  noTail = false,
  tailShift = 0,
  flatBR = false,
  flatBL = false,
) {
  // Draw rounded rect body
  roundRect(ctx, x, y, w, h, r, r, flatBR ? 0 : r, flatBL ? 0 : r);
  ctx.fill();

  if (noTail) return;

  // Draw tail as separate shape overlapping the corner
  const ts = tailShift;
  ctx.beginPath();
  if (isUser) {
    ctx.moveTo(x + w - s(10) + ts, y + h - s(18));
    ctx.bezierCurveTo(
      x + w - s(6) + ts,
      y + h + s(4),
      x + w - s(2) + ts,
      y + h + s(10),
      x + w + s(4) + ts,
      y + h + s(10),
    );
    ctx.bezierCurveTo(
      x + w - s(4) + ts,
      y + h + s(6),
      x + w - s(10) + ts,
      y + h,
      x + w - s(30) + ts,
      y + h,
    );
    ctx.closePath();
  } else {
    ctx.moveTo(x + s(10) - ts, y + h - s(18));
    ctx.bezierCurveTo(
      x + s(6) - ts,
      y + h + s(4),
      x + s(2) - ts,
      y + h + s(10),
      x - s(4) - ts,
      y + h + s(10),
    );
    ctx.bezierCurveTo(
      x + s(4) - ts,
      y + h + s(6),
      x + s(10) - ts,
      y + h,
      x + s(30) - ts,
      y + h,
    );
    ctx.closePath();
  }
  ctx.fill();
}

function s(v: number) {
  return v * SCALE;
}

/** Returns the height of a message bubble in unscaled pixels (divide by SCALE not needed — already in logical px). */
export function measureBubbleHeight(text: string): number {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const msgFontSize = s(16);
  ctx.font = `400 ${msgFontSize}px Inter, -apple-system, system-ui, sans-serif`;
  const maxBubbleW = W * 0.7;
  const padX = s(14);
  const padY = s(10);

  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxBubbleW - padX * 2) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const lineH = s(21);
  const singleBubbleH = (lineH + padY * 2) / SCALE + 10;
  const extraLinesH = ((lines.length - 1) * lineH) / SCALE;
  return singleBubbleH + extraLinesH * 0.97;
}

function drawStatusBar(ctx: CanvasRenderingContext2D) {
  const topInset = s(59);
  const statusY = topInset - s(36);
  const now = new Date();
  ctx.fillStyle = "#000";
  ctx.font = `700 ${s(17)}px Inter, -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const statusBarTime = now.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });
  ctx.fillText(statusBarTime, s(43), statusY + s(10));

  const iconsY = statusY + s(10);
  const iconGap = s(6);
  const iconCenterY = iconsY;

  // Battery
  const batW = s(29);
  const batH = s(13.5);
  const batCapW = s(2);
  const batRight = W - s(30);
  const batX = batRight - batCapW - batW;
  const batY = iconCenterY - batH / 2;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = s(1);
  roundRect(ctx, batX, batY, batW, batH, s(3), s(3), s(3), s(3));
  ctx.stroke();
  const bi = s(2);
  ctx.fillStyle = "#000";
  roundRect(
    ctx,
    batX + bi,
    batY + bi,
    batW - bi * 2,
    batH - bi * 2,
    s(1.5),
    s(1.5),
    s(1.5),
    s(1.5),
  );
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  roundRect(
    ctx,
    batX + batW + s(1),
    iconCenterY - s(2.5),
    batCapW,
    s(5),
    s(0.8),
    s(0.8),
    s(0.8),
    s(0.8),
  );
  ctx.fill();

  // WiFi
  const wifiCx = batX - iconGap - s(7);
  const wifiBaseline = iconCenterY + s(7);
  ctx.fillStyle = "#000";
  const wifiLayers = [
    { outer: s(14), inner: s(10.5) },
    { outer: s(9.3), inner: s(5.8) },
    { outer: s(4.6), inner: s(0) },
  ];
  const wifiAngleStart = -Math.PI * 0.75;
  const wifiAngleEnd = -Math.PI * 0.25;
  for (const layer of wifiLayers) {
    ctx.beginPath();
    if (layer.inner > 0) {
      ctx.arc(wifiCx, wifiBaseline, layer.outer, wifiAngleStart, wifiAngleEnd);
      ctx.arc(
        wifiCx,
        wifiBaseline,
        layer.inner,
        wifiAngleEnd,
        wifiAngleStart,
        true,
      );
      ctx.closePath();
    } else {
      ctx.arc(wifiCx, wifiBaseline, layer.outer, wifiAngleStart, wifiAngleEnd);
      ctx.lineTo(wifiCx, wifiBaseline);
      ctx.closePath();
    }
    ctx.fill();
  }

  // Cellular
  const cellBarW = s(3.5);
  const cellBarGap = s(1.5);
  const cellTotalW = 4 * cellBarW + 3 * cellBarGap;
  const cellRight = wifiCx - s(12) - iconGap;
  const cellBaseX = cellRight - cellTotalW;
  const maxCellH = s(13.5);
  const cellBottom = iconCenterY + maxCellH / 2;
  ctx.fillStyle = "#000";
  const cellHeights = [s(4.5), s(7), s(10), s(13.5)];
  for (let i = 0; i < 4; i++) {
    const bx = cellBaseX + i * (cellBarW + cellBarGap);
    const bh = cellHeights[i];
    roundRect(ctx, bx, cellBottom - bh, cellBarW, bh, s(1), s(1), s(1), s(1));
    ctx.fill();
  }

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawBackButton(ctx: CanvasRenderingContext2D, label: string) {
  const topInset = s(59);
  const navY = topInset;
  const backBtnFont = `700 ${s(16)}px Inter, -apple-system, system-ui, sans-serif`;
  ctx.font = backBtnFont;
  const backLabelW = ctx.measureText(label).width;
  const backH = s(40);
  const backPadL = s(20);
  const backChevronW = s(12);
  const backGap = s(2);
  const backPadR = s(14);
  const backW = backPadL + backChevronW + backGap + backLabelW + backPadR;
  const backX = s(17);
  const backY = navY + s(15) - backH / 2;
  const backCy = navY + s(15);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.15)";
  ctx.shadowBlur = s(8);
  ctx.shadowOffsetY = s(2);
  ctx.fillStyle = "#ffffff";
  pill(ctx, backX, backY, backW, backH);
  ctx.fill();
  ctx.restore();

  // Chevron
  const chevronCx = backX + backPadL;
  ctx.strokeStyle = "#3c3c43";
  ctx.lineWidth = s(2.2);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(chevronCx + s(2.5), backCy - s(7));
  ctx.lineTo(chevronCx - s(4.5), backCy);
  ctx.lineTo(chevronCx + s(2.5), backCy + s(7));
  ctx.stroke();
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";

  // Label
  ctx.fillStyle = "#3c3c43";
  ctx.font = backBtnFont;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, chevronCx + backChevronW + backGap, backCy);
  ctx.textBaseline = "alphabetic";
}

function renderLoginCard(
  title = "What's your phone number?",
  subtitle?: string,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const screenR = s(60);
  ctx.save();
  roundRect(ctx, 0, 0, W, H, screenR, screenR, screenR, screenR);
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  drawStatusBar(ctx);
  drawBackButton(ctx, "Home");

  // Title text just below the back button
  const textY = s(59) + s(15) + s(20) + s(60);
  ctx.fillStyle = "#000";
  ctx.font = `600 ${s(22)}px Inter, -apple-system, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(title, W / 2, textY);

  // Subtitle below title
  if (subtitle) {
    ctx.fillStyle = "#8e8e93";
    ctx.font = `400 ${s(16)}px Inter, -apple-system, system-ui, sans-serif`;
    ctx.fillText(subtitle, W / 2, textY + s(42));
  }

  ctx.restore();
  return canvas;
}

function renderChatContent(
  visibleCount: number,
  avatarImg?: HTMLImageElement,
  lastMsgProgress = 1,
  contentYOffset = 0,
  scrollY = 0,
  extraMessages: ExtraMessage[] = [],
): HTMLCanvasElement {
  return renderChatToCanvas(
    visibleCount,
    avatarImg,
    lastMsgProgress,
    contentYOffset,
    scrollY,
    extraMessages,
    0,
  );
}

export function renderChatToCanvas(
  visibleCount: number,
  avatarImg?: HTMLImageElement,
  lastMsgProgress = 1,
  contentYOffset = 0,
  scrollY = 0,
  extraMessages: ExtraMessage[] = [],
  switcherProgress = 0,
  switcherShiftProgress = 0,
  switcherFinalProgress = 0,
  switcherReversed = false,
  loginTitle?: string,
  loginSubtitle?: string,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // Enable subpixel antialiasing
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // ── App switcher mode ──
  if (switcherProgress > 0) {
    // Wallpaper background
    if (wallpaperImg?.complete && wallpaperImg.naturalWidth > 0) {
      ctx.drawImage(wallpaperImg, 0, 0, W, H);
    } else {
      ctx.fillStyle = "#22c55e";
      ctx.fillRect(0, 0, W, H);
    }

    // Shared values
    const contentScale = 1 - 0.25 * switcherProgress; // 1 → 0.75
    const shiftX = (60 / 100) * W * switcherShiftProgress;
    const finalShiftX = (60 / 100) * W * switcherFinalProgress;
    const cardR = s(60);
    const scaledW = W * contentScale;
    const leftCardX = W / 2 - scaledW * 1.05;
    const leftShiftX =
      leftCardX - W / 2 + (W / 2 - leftCardX) * switcherShiftProgress;
    const leftScale = contentScale + (1 - contentScale) * switcherFinalProgress;

    // Render both card canvases
    const chatCanvas = renderChatContent(
      visibleCount,
      avatarImg,
      lastMsgProgress,
      contentYOffset,
      scrollY,
      extraMessages,
    );
    const loginCanvas = renderLoginCard(loginTitle, loginSubtitle);
    const leftContent = switcherReversed ? chatCanvas : loginCanvas;
    const frontContent = switcherReversed ? loginCanvas : chatCanvas;

    // ── Left card (behind): login when opening, chat when closing ──
    ctx.save();
    ctx.globalAlpha = switcherProgress;
    ctx.translate(leftShiftX, 0);
    ctx.translate(W / 2, H / 2);
    ctx.scale(leftScale, leftScale);
    ctx.translate(-W / 2, -H / 2);
    roundRect(ctx, 0, 0, W, H, cardR, cardR, cardR, cardR);
    ctx.clip();
    ctx.drawImage(leftContent, 0, 0, W, H);
    ctx.restore();

    // ── Front card (on top): chat when opening, login when closing ──
    // Shadow
    ctx.save();
    ctx.translate(shiftX + finalShiftX, 0);
    ctx.translate(W / 2, H / 2);
    ctx.scale(contentScale, contentScale);
    ctx.translate(-W / 2, -H / 2);
    ctx.shadowColor = "rgba(0,0,0,0.07)";
    ctx.shadowBlur = s(12);
    ctx.shadowOffsetX = -s(6);
    ctx.shadowOffsetY = s(2);
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, 0, 0, W, H, cardR, cardR, cardR, cardR);
    ctx.fill();
    ctx.restore();

    // Content
    ctx.save();
    ctx.translate(shiftX + finalShiftX, 0);
    ctx.translate(W / 2, H / 2);
    ctx.scale(contentScale, contentScale);
    ctx.translate(-W / 2, -H / 2);
    roundRect(ctx, 0, 0, W, H, cardR, cardR, cardR, cardR);
    ctx.clip();
    ctx.drawImage(frontContent, 0, 0, W, H);
    ctx.restore();

    return canvas;
  }

  // ── Background with rounded corners ──
  const screenR = s(60);
  ctx.save();
  roundRect(ctx, 0, 0, W, H, screenR, screenR, screenR, screenR);
  ctx.clip();
  if (
    currentRenderPlatform === "telegram" &&
    tgBgImg &&
    tgBgImg.complete &&
    tgBgImg.naturalWidth > 0
  ) {
    ctx.drawImage(tgBgImg, 0, 0, W, H);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
  }

  // ── Dynamic Island / notch area (top padding) ──
  const topInset = s(59);
  const now = new Date();
  const statusTime = now.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  // ── Compute positions ──
  const navY = topInset;
  const contactY = navY + s(40);
  const sepY = contactY + s(90);
  const scrollOffset = s(scrollY);
  const headerShift = Math.min(scrollOffset * 0.15, s(40));

  // ── Scrollable content (date + messages) — clipped below header ──
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();

  // ── Date (appears with first message) ──
  if (visibleCount >= 1) {
    const dateProgress =
      visibleCount === 1 && lastMsgProgress < 1 ? lastMsgProgress : 1;
    const dateAlpha = dateProgress;
    const dateSlide = s(10) * (1 - dateProgress);
    ctx.save();
    ctx.globalAlpha = dateAlpha;
    const isTGDate = currentRenderPlatform === "telegram";
    const dateText = isTGDate ? "Today" : `Today ${statusTime}`;
    const dateFontSize = s(13);
    ctx.font = `400 ${dateFontSize}px Inter, -apple-system, system-ui, sans-serif`;
    const dateY =
      sepY + s(20) - scrollOffset + dateSlide - (isTGDate ? s(65) : 0);
    ctx.textAlign = "center";
    if (isTGDate) {
      const textW = ctx.measureText(dateText).width;
      const chipPadX = s(10);
      const chipPadY = s(5);
      const chipW = textW + chipPadX * 2;
      const chipH = dateFontSize + chipPadY * 2;
      const chipX = W / 2 - chipW / 2;
      const chipY = dateY - dateFontSize - chipPadY + s(2);
      const chipR = isTGDate ? chipH / 2 : s(8);
      ctx.fillStyle = isTGDate ? "rgba(0,0,0,0.2)" : "#ffffff";
      ctx.beginPath();
      ctx.moveTo(chipX + chipR, chipY);
      ctx.lineTo(chipX + chipW - chipR, chipY);
      ctx.quadraticCurveTo(chipX + chipW, chipY, chipX + chipW, chipY + chipR);
      ctx.lineTo(chipX + chipW, chipY + chipH - chipR);
      ctx.quadraticCurveTo(
        chipX + chipW,
        chipY + chipH,
        chipX + chipW - chipR,
        chipY + chipH,
      );
      ctx.lineTo(chipX + chipR, chipY + chipH);
      ctx.quadraticCurveTo(chipX, chipY + chipH, chipX, chipY + chipH - chipR);
      ctx.lineTo(chipX, chipY + chipR);
      ctx.quadraticCurveTo(chipX, chipY, chipX + chipR, chipY);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = isTGDate ? "#ffffff" : "#8e8e93";
    ctx.fillText(dateText, W / 2, dateY);
    ctx.textAlign = "left";
    ctx.restore();
  }

  // ── Messages ──
  const isTGMsg = currentRenderPlatform === "telegram";
  let msgY = sepY + s(32) - scrollOffset - (isTGMsg ? s(60) : 0);
  const msgFontSize = s(16);
  const msgFont = `400 ${msgFontSize}px Inter, -apple-system, system-ui, sans-serif`;
  const maxBubbleW = W * 0.7;
  const padX = s(14);
  const padY = s(10);
  const marginX = s(14);
  const bubbleR = s(18);

  const msgs = getMessages();
  const count = Math.min(visibleCount, msgs.length);

  for (let m = 0; m < count; m++) {
    const msg = msgs[m];
    const isUser = msg.from === "user";
    const isLast = m === count - 1 && lastMsgProgress < 1;
    ctx.font = msgFont;

    // Word wrap
    const words = msg.text.split(" ");
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxBubbleW - padX * 2) {
        if (line) lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);

    const lineH = s(21);
    const textBlockH = lines.length * lineH;
    const bubbleW = Math.min(
      maxBubbleW,
      Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2,
    );
    const bubbleH = textBlockH + padY * 2;
    const bubbleX = isUser ? W - marginX - bubbleW : marginX;

    // iMessage slide-up + scale animation for newest message
    const slideOffset = isLast ? s(30) * (1 - lastMsgProgress) : 0;
    const scale = isLast ? 0.7 + 0.3 * lastMsgProgress : 1;
    const alpha = isLast ? lastMsgProgress : 1;

    ctx.save();
    ctx.globalAlpha = alpha;
    if (isLast) {
      const ox = isUser ? bubbleX + bubbleW : bubbleX;
      const oy = msgY + bubbleH + slideOffset;
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);
      ctx.translate(-ox, -oy);
    }

    // Subtle shadow for depth
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.06)";
    ctx.shadowBlur = s(4);
    ctx.shadowOffsetY = s(1);
    const isTG = currentRenderPlatform === "telegram";
    ctx.fillStyle = isUser
      ? isTG
        ? "#e9fec7"
        : "#007AFF"
      : isTG
        ? "#ffffff"
        : "#ebebed";
    iMessageBubble(
      ctx,
      bubbleX,
      msgY + slideOffset,
      bubbleW,
      bubbleH,
      bubbleR,
      isUser,
      false,
      isTG ? s(8) : 0,
      isTG && isUser,
      isTG && !isUser,
    );
    ctx.restore();

    // Text — thinner weight on blue to match visual weight of black-on-grey
    ctx.fillStyle = isUser ? (isTG ? "#000000" : "#ffffff") : "#000000";
    ctx.font =
      isUser && !isTG
        ? `200 ${msgFontSize}px Inter, -apple-system, system-ui, sans-serif`
        : msgFont;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(
        lines[i],
        bubbleX + padX,
        msgY + slideOffset + padY + s(13) + i * lineH,
      );
    }

    ctx.restore();

    msgY += bubbleH + s(10);
  }

  // ── Extra messages (user-sent and bot responses) ──
  for (let e = 0; e < extraMessages.length; e++) {
    const extra = extraMessages[e];
    const isUser = extra.from === "user";
    const isLast = e === extraMessages.length - 1 && extra.progress < 1;

    if (extra.typing) {
      // ── Typing indicator (three dots in gray bubble) ──
      const typingW = s(75);
      const typingH = s(40);
      const typingX = marginX;

      const slideOffset = isLast ? s(30) * (1 - extra.progress) : 0;
      const scale = isLast ? 0.7 + 0.3 * extra.progress : 1;
      const alpha = isLast ? extra.progress : 1;

      ctx.save();
      ctx.globalAlpha = alpha;
      if (isLast) {
        const ox = typingX;
        const oy = msgY + typingH + slideOffset;
        ctx.translate(ox, oy);
        ctx.scale(scale, scale);
        ctx.translate(-ox, -oy);
      }

      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.06)";
      ctx.shadowBlur = s(4);
      ctx.shadowOffsetY = s(1);
      const isTGTyping = currentRenderPlatform === "telegram";
      ctx.fillStyle = isTGTyping ? "#ffffff" : "#ebebed";
      iMessageBubble(
        ctx,
        typingX,
        msgY + slideOffset,
        typingW,
        typingH,
        bubbleR,
        false,
        undefined,
        isTGTyping ? s(8) : 0,
        false,
        isTGTyping,
      );
      ctx.restore();

      // Three pulsing dots
      const dotR = s(6);
      const dotGap = s(18);
      const dotsBaseY = msgY + slideOffset + typingH / 2;
      const dotsStartX = typingX + typingW / 2 - dotGap;
      const now = Date.now();

      for (let d = 0; d < 3; d++) {
        const phase = (now / 1000 + d * 0.33) % 1;
        const pulse = Math.max(0, Math.sin(phase * Math.PI * 2));
        const dotAlpha = 0.1 + 0.23 * pulse;
        ctx.fillStyle =
          currentRenderPlatform === "telegram"
            ? `rgba(42,171,238,${dotAlpha + 0.2})`
            : `rgba(0,0,0,${dotAlpha})`;
        ctx.beginPath();
        ctx.arc(dotsStartX + d * dotGap, dotsBaseY, dotR, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
      msgY += typingH + s(10);
    } else {
      // ── Text message (user or bot) ──
      ctx.font = msgFont;

      const words = extra.text.split(" ");
      const lines: string[] = [];
      let line = "";
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxBubbleW - padX * 2) {
          if (line) lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);

      const lineH = s(21);
      const textBlockH = lines.length * lineH;
      const bubbleW = Math.min(
        maxBubbleW,
        Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2,
      );
      const bubbleH = textBlockH + padY * 2;
      const bubbleX = isUser ? W - marginX - bubbleW : marginX;

      const slideOffset = isLast ? s(30) * (1 - extra.progress) : 0;
      const scale = isLast ? 0.7 + 0.3 * extra.progress : 1;
      const alpha = isLast ? extra.progress : 1;

      ctx.save();
      ctx.globalAlpha = alpha;
      if (isLast) {
        const ox = isUser ? bubbleX + bubbleW : bubbleX;
        const oy = msgY + bubbleH + slideOffset;
        ctx.translate(ox, oy);
        ctx.scale(scale, scale);
        ctx.translate(-ox, -oy);
      }

      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.06)";
      ctx.shadowBlur = s(4);
      ctx.shadowOffsetY = s(1);
      const isTG2 = currentRenderPlatform === "telegram";
      ctx.fillStyle = isUser
        ? isTG2
          ? "#e9fec7"
          : "#007AFF"
        : isTG2
          ? "#ffffff"
          : "#ebebed";
      iMessageBubble(
        ctx,
        bubbleX,
        msgY + slideOffset,
        bubbleW,
        bubbleH,
        bubbleR,
        isUser,
        undefined,
        isTG2 ? s(8) : 0,
        isTG2 && isUser,
        isTG2 && !isUser,
      );
      ctx.restore();

      ctx.fillStyle = isUser ? (isTG2 ? "#000000" : "#ffffff") : "#000000";
      ctx.font =
        isUser && !isTG2
          ? `200 ${msgFontSize}px Inter, -apple-system, system-ui, sans-serif`
          : msgFont;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(
          lines[i],
          bubbleX + padX,
          msgY + slideOffset + padY + s(13) + i * lineH,
        );
      }

      ctx.restore();
      msgY += bubbleH + s(10);
    }
  }

  ctx.restore(); // end scrollable clip

  // ── Fixed header overlay (drawn on top of scrolled content) ──
  if (currentRenderPlatform === "telegram") {
    const altHeaderBottom = navY + s(52);
    ctx.fillStyle = "#f5f5f5";
    ctx.fillRect(0, 0, W, altHeaderBottom);
    ctx.strokeStyle = "#d1d1d6";
    ctx.lineWidth = s(0.5);
    ctx.beginPath();
    ctx.moveTo(0, altHeaderBottom);
    ctx.lineTo(W, altHeaderBottom);
    ctx.stroke();
  } else {
    const headerBottom = sepY - headerShift + s(60);
    const grad2 = ctx.createLinearGradient(0, 0, 0, headerBottom);
    grad2.addColorStop(0, "rgba(255,255,255,0.9)");
    grad2.addColorStop(0.5, "rgba(255,255,255,0.65)");
    grad2.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad2;
    ctx.fillRect(0, 0, W, headerBottom);
  }

  // ── Status bar (drawn on top of gradient) ──
  const statusY = topInset - s(36);
  ctx.fillStyle = "#000";
  ctx.font = `700 ${s(17)}px Inter, -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const statusBarTime = now.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });
  ctx.fillText(statusBarTime, s(43), statusY + s(10));

  // Right status icons
  const iconsY = statusY + s(10);
  const iconGap = s(6);
  const iconCenterY = iconsY;

  // Battery
  const batW = s(29);
  const batH = s(13.5);
  const batCapW = s(2);
  const batRight = W - s(30);
  const batX = batRight - batCapW - batW;
  const batY = iconCenterY - batH / 2;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = s(1);
  roundRect(ctx, batX, batY, batW, batH, s(3), s(3), s(3), s(3));
  ctx.stroke();
  const bi = s(2);
  ctx.fillStyle = "#000";
  roundRect(
    ctx,
    batX + bi,
    batY + bi,
    batW - bi * 2,
    batH - bi * 2,
    s(1.5),
    s(1.5),
    s(1.5),
    s(1.5),
  );
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  roundRect(
    ctx,
    batX + batW + s(1),
    iconCenterY - s(2.5),
    batCapW,
    s(5),
    s(0.8),
    s(0.8),
    s(0.8),
    s(0.8),
  );
  ctx.fill();

  // WiFi
  const wifiCx = batX - iconGap - s(7);
  const wifiBaseline = iconCenterY + s(7);
  ctx.fillStyle = "#000";
  const wifiLayers = [
    { outer: s(14), inner: s(10.5) },
    { outer: s(9.3), inner: s(5.8) },
    { outer: s(4.6), inner: s(0) },
  ];
  const wifiAngleStart = -Math.PI * 0.75;
  const wifiAngleEnd = -Math.PI * 0.25;
  for (const layer of wifiLayers) {
    ctx.beginPath();
    if (layer.inner > 0) {
      ctx.arc(wifiCx, wifiBaseline, layer.outer, wifiAngleStart, wifiAngleEnd);
      ctx.arc(
        wifiCx,
        wifiBaseline,
        layer.inner,
        wifiAngleEnd,
        wifiAngleStart,
        true,
      );
      ctx.closePath();
    } else {
      ctx.arc(wifiCx, wifiBaseline, layer.outer, wifiAngleStart, wifiAngleEnd);
      ctx.lineTo(wifiCx, wifiBaseline);
      ctx.closePath();
    }
    ctx.fill();
  }

  // Cellular
  const cellBarW = s(3.5);
  const cellBarGap = s(1.5);
  const cellTotalW = 4 * cellBarW + 3 * cellBarGap;
  const cellRight = wifiCx - s(12) - iconGap;
  const cellBaseX = cellRight - cellTotalW;
  const maxCellH = s(13.5);
  const cellBottom = iconCenterY + maxCellH / 2;
  ctx.fillStyle = "#000";
  const cellHeights = [s(4.5), s(7), s(10), s(13.5)];
  for (let i = 0; i < 4; i++) {
    const bx = cellBaseX + i * (cellBarW + cellBarGap);
    const bh = cellHeights[i];
    roundRect(ctx, bx, cellBottom - bh, cellBarW, bh, s(1), s(1), s(1), s(1));
    ctx.fill();
  }

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  if (currentRenderPlatform === "telegram") {
    // ── Telegram-style header ──
    const chevCy = navY + s(24);

    // Back chevron + "Log In" text (blue)
    ctx.strokeStyle = "#007AFF";
    ctx.lineWidth = s(3);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(s(24), chevCy - s(10));
    ctx.lineTo(s(14), chevCy);
    ctx.lineTo(s(24), chevCy + s(10));
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";

    ctx.fillStyle = "#007AFF";
    ctx.font = `400 ${s(17)}px Inter, -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("Log In", s(36), chevCy + s(2));
    ctx.textBaseline = "alphabetic";

    // Centered name "Eliza"
    ctx.fillStyle = "#000";
    ctx.font = `700 ${s(17)}px Inter, -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("Eliza", W / 2, chevCy - s(12));

    // "online" subtitle centered (blue)
    ctx.fillStyle = "#007AFF";
    ctx.font = `400 ${s(13)}px Inter, -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("online", W / 2, chevCy + s(8));
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    // Avatar circle (right side)
    const tgAvatarR = s(20);
    const tgAvatarCx = W - s(36);
    const tgAvatarCy = chevCy;
    ctx.save();
    ctx.beginPath();
    ctx.arc(tgAvatarCx, tgAvatarCy, tgAvatarR, 0, Math.PI * 2);
    ctx.clip();
    if (avatarImg) {
      ctx.drawImage(
        avatarImg,
        tgAvatarCx - tgAvatarR,
        tgAvatarCy - tgAvatarR,
        tgAvatarR * 2,
        tgAvatarR * 2,
      );
    } else {
      const avatarGrad = ctx.createLinearGradient(
        tgAvatarCx - tgAvatarR,
        tgAvatarCy - tgAvatarR,
        tgAvatarCx + tgAvatarR,
        tgAvatarCy + tgAvatarR,
      );
      avatarGrad.addColorStop(0, "#A8A8B0");
      avatarGrad.addColorStop(1, "#C8C8D0");
      ctx.fillStyle = avatarGrad;
      ctx.fill();
    }
    ctx.restore();
  } else {
    // ── iMessage-style header ──
    // Back button — pill with chevron + "Log In"
    const backBtnFont = `700 ${s(16)}px Inter, -apple-system, system-ui, sans-serif`;
    ctx.font = backBtnFont;
    const backLabel = "Log In";
    const backLabelW = ctx.measureText(backLabel).width;
    const backH = s(40);
    const backPadL = s(20);
    const backChevronW = s(12);
    const backGap = s(2);
    const backPadR = s(14);
    const backW = backPadL + backChevronW + backGap + backLabelW + backPadR;
    const backX = s(17);
    const backY = navY + s(15) - backH / 2;
    const backCy = navY + s(15);

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.15)";
    ctx.shadowBlur = s(8);
    ctx.shadowOffsetY = s(2);
    ctx.fillStyle = "#ffffff";
    pill(ctx, backX, backY, backW, backH);
    ctx.fill();
    ctx.restore();

    // Chevron
    const chevronCx = backX + backPadL;
    ctx.strokeStyle = "#3c3c43";
    ctx.lineWidth = s(2.2);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(chevronCx + s(2.5), backCy - s(7));
    ctx.lineTo(chevronCx - s(4.5), backCy);
    ctx.lineTo(chevronCx + s(2.5), backCy + s(7));
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";

    // Label
    ctx.fillStyle = "#3c3c43";
    ctx.font = backBtnFont;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(backLabel, chevronCx + backChevronW + backGap, backCy);
    ctx.textBaseline = "alphabetic";

    // Video button — circle with camera icon
    const vidCx = W - s(37);
    const vidCy = backCy;
    const vidR = s(20);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.15)";
    ctx.shadowBlur = s(8);
    ctx.shadowOffsetY = s(2);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(vidCx, vidCy, vidR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "#3c3c43";
    ctx.lineWidth = s(2);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const camW = s(17);
    const camH = s(13.5);
    const camX = vidCx - s(11);
    const camY = vidCy - camH / 2;
    roundRect(ctx, camX, camY, camW, camH, s(3), s(3), s(3), s(3));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(camX + camW, vidCy - s(3));
    ctx.lineTo(camX + camW + s(5.5), vidCy - s(5));
    ctx.lineTo(camX + camW + s(5.5), vidCy + s(5));
    ctx.lineTo(camX + camW, vidCy + s(3));
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";

    // ── Contact area ──
    const avatarCx = W / 2;
    const avatarCy = contactY + s(26) + s(contentYOffset) - headerShift;
    const avatarR = s(26);

    // Name with background pill and shadow
    ctx.font = `800 ${s(16)}px Inter, -apple-system, system-ui, sans-serif`;
    const nameText = "Eliza";
    const nameTextW = ctx.measureText(nameText).width;
    const namePadX = s(16);
    const namePadY = s(8);
    const nameH = s(16) + namePadY * 2;
    const nameW = nameTextW + namePadX * 2;
    const nameX = avatarCx - nameW / 2;
    const nameY = contactY + s(48) - headerShift;
    const shadowProgress =
      contentYOffset === 0 ? 1 : Math.max(0, 1 - Math.abs(contentYOffset) / 4);
    const arrowProgress =
      contentYOffset === 0 ? 1 : Math.max(0, 1 - Math.abs(contentYOffset) / 2);
    const textShift = s(4) * arrowProgress;
    const textCenterX = avatarCx - textShift;
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.15 * shadowProgress})`;
    ctx.shadowBlur = s(8) * shadowProgress;
    ctx.shadowOffsetY = s(3) * shadowProgress;
    ctx.fillStyle = "#ffffff";
    pill(ctx, nameX, nameY, nameW, nameH);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.fillText(nameText, textCenterX, nameY + nameH / 2 + s(5.5));

    // Small chevron arrow after name
    if (arrowProgress > 0) {
      const arrowX = textCenterX + nameTextW / 2 + s(8);
      const arrowY = nameY + nameH / 2;
      ctx.save();
      ctx.globalAlpha = arrowProgress;
      ctx.strokeStyle = "#aeaeb2";
      ctx.lineWidth = s(2.5);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(arrowX - s(1.5), arrowY - s(4));
      ctx.lineTo(arrowX + s(1.5), arrowY);
      ctx.lineTo(arrowX - s(1.5), arrowY + s(4));
      ctx.stroke();
      ctx.restore();
    }

    // Avatar circle with image
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarCx, avatarCy, avatarR, 0, Math.PI * 2);
    ctx.clip();
    if (avatarImg) {
      ctx.drawImage(
        avatarImg,
        avatarCx - avatarR,
        avatarCy - avatarR,
        avatarR * 2,
        avatarR * 2,
      );
    } else {
      const avatarGrad = ctx.createLinearGradient(
        avatarCx - avatarR,
        avatarCy - avatarR,
        avatarCx + avatarR,
        avatarCy + avatarR,
      );
      avatarGrad.addColorStop(0, "#A8A8B0");
      avatarGrad.addColorStop(1, "#C8C8D0");
      ctx.fillStyle = avatarGrad;
      ctx.fill();
    }
    ctx.restore();
  }

  // ── Bottom input bar ──
  // Separator
  ctx.strokeStyle = "#e5e5ea";
  ctx.lineWidth = s(0.5);
  ctx.beginPath();
  ctx.moveTo(0, H - s(58));
  ctx.lineTo(W, H - s(58));
  ctx.stroke();

  const inputBarY = H - s(50);

  // Plus circle button
  ctx.fillStyle = "#007AFF";
  ctx.beginPath();
  ctx.arc(s(26), inputBarY + s(18), s(15), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = s(2.5);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(s(26) - s(7), inputBarY + s(18));
  ctx.lineTo(s(26) + s(7), inputBarY + s(18));
  ctx.moveTo(s(26), inputBarY + s(18) - s(7));
  ctx.lineTo(s(26), inputBarY + s(18) + s(7));
  ctx.stroke();
  ctx.lineCap = "butt";

  // Input field
  const inputX = s(52);
  const inputW = W - s(64);
  const inputH = s(36);
  const inputFieldY = inputBarY;
  ctx.strokeStyle = "#c7c7cc";
  ctx.lineWidth = s(1);
  pill(ctx, inputX, inputFieldY, inputW, inputH);
  ctx.stroke();

  ctx.fillStyle = "#c7c7cc";
  ctx.font = `400 ${s(16)}px Inter, -apple-system, system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText("iMessage", inputX + s(16), inputFieldY + s(23));

  // Home indicator
  ctx.fillStyle = "#000";
  const indW = s(134);
  roundRect(
    ctx,
    (W - indW) / 2,
    H - s(10),
    indW,
    s(5),
    s(2.5),
    s(2.5),
    s(2.5),
    s(2.5),
  );
  ctx.fill();

  ctx.restore(); // end rounded-corner clip

  return canvas;
}
