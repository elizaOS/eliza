/**
 * Canvas renderer for the fixed iMessage transcript on the homepage phone.
 *
 * The renderer intentionally contains no channel switching, login card, video
 * control, or interactive composer behavior; those actions live in the direct
 * channel links surrounding the phone.
 */
import { BRAND_COLORS } from "@elizaos/shared/brand";

interface Message {
  from: "bot" | "user";
  text: string;
}

const MESSAGES: Message[] = [
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

const SCALE = 4;
const WIDTH = 390 * SCALE;
const HEIGHT = 844 * SCALE;

function scaled(value: number) {
  return value * SCALE;
}

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas context is not available");
  return context;
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  topLeft: number,
  topRight: number,
  bottomRight: number,
  bottomLeft: number,
) {
  context.beginPath();
  context.moveTo(x + topLeft, y);
  context.lineTo(x + width - topRight, y);
  context.quadraticCurveTo(x + width, y, x + width, y + topRight);
  context.lineTo(x + width, y + height - bottomRight);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - bottomRight,
    y + height,
  );
  context.lineTo(x + bottomLeft, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - bottomLeft);
  context.lineTo(x, y + topLeft);
  context.quadraticCurveTo(x, y, x + topLeft, y);
  context.closePath();
}

function pill(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const radius = height / 2;
  roundRect(context, x, y, width, height, radius, radius, radius, radius);
}

function drawBubble(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  isUser: boolean,
) {
  const radius = scaled(18);
  roundRect(context, x, y, width, height, radius, radius, radius, radius);
  context.fill();

  context.beginPath();
  if (isUser) {
    context.moveTo(x + width - scaled(10), y + height - scaled(18));
    context.bezierCurveTo(
      x + width - scaled(6),
      y + height + scaled(4),
      x + width - scaled(2),
      y + height + scaled(10),
      x + width + scaled(4),
      y + height + scaled(10),
    );
    context.bezierCurveTo(
      x + width - scaled(4),
      y + height + scaled(6),
      x + width - scaled(10),
      y + height,
      x + width - scaled(30),
      y + height,
    );
  } else {
    context.moveTo(x + scaled(10), y + height - scaled(18));
    context.bezierCurveTo(
      x + scaled(6),
      y + height + scaled(4),
      x + scaled(2),
      y + height + scaled(10),
      x - scaled(4),
      y + height + scaled(10),
    );
    context.bezierCurveTo(
      x + scaled(4),
      y + height + scaled(6),
      x + scaled(10),
      y + height,
      x + scaled(30),
      y + height,
    );
  }
  context.closePath();
  context.fill();
}

function drawStatusBar(context: CanvasRenderingContext2D) {
  const statusCenterY = scaled(33);
  const now = new Date();
  const time = now.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });

  context.fillStyle = BRAND_COLORS.black;
  context.font = `700 ${scaled(17)}px Inter, -apple-system, system-ui, sans-serif`;
  context.textBaseline = "middle";
  context.textAlign = "left";
  context.fillText(time, scaled(43), statusCenterY);

  const batteryWidth = scaled(29);
  const batteryHeight = scaled(13.5);
  const batteryX = WIDTH - scaled(61);
  const batteryY = statusCenterY - batteryHeight / 2;
  context.strokeStyle = "rgba(0,0,0,0.35)";
  context.lineWidth = scaled(1);
  roundRect(
    context,
    batteryX,
    batteryY,
    batteryWidth,
    batteryHeight,
    scaled(3),
    scaled(3),
    scaled(3),
    scaled(3),
  );
  context.stroke();
  context.fillStyle = BRAND_COLORS.black;
  roundRect(
    context,
    batteryX + scaled(2),
    batteryY + scaled(2),
    batteryWidth - scaled(4),
    batteryHeight - scaled(4),
    scaled(1.5),
    scaled(1.5),
    scaled(1.5),
    scaled(1.5),
  );
  context.fill();
  context.fillStyle = "rgba(0,0,0,0.35)";
  roundRect(
    context,
    batteryX + batteryWidth + scaled(1),
    statusCenterY - scaled(2.5),
    scaled(2),
    scaled(5),
    scaled(0.8),
    scaled(0.8),
    scaled(0.8),
    scaled(0.8),
  );
  context.fill();

  const wifiCenterX = batteryX - scaled(19);
  const wifiBaseline = statusCenterY + scaled(7);
  const wifiAngleStart = -Math.PI * 0.75;
  const wifiAngleEnd = -Math.PI * 0.25;
  const wifiLayers = [
    { outer: scaled(14), inner: scaled(10.5) },
    { outer: scaled(9.3), inner: scaled(5.8) },
    { outer: scaled(4.6), inner: 0 },
  ];
  context.fillStyle = BRAND_COLORS.black;
  for (const layer of wifiLayers) {
    context.beginPath();
    context.arc(
      wifiCenterX,
      wifiBaseline,
      layer.outer,
      wifiAngleStart,
      wifiAngleEnd,
    );
    if (layer.inner > 0) {
      context.arc(
        wifiCenterX,
        wifiBaseline,
        layer.inner,
        wifiAngleEnd,
        wifiAngleStart,
        true,
      );
    } else {
      context.lineTo(wifiCenterX, wifiBaseline);
    }
    context.closePath();
    context.fill();
  }

  const cellBarWidth = scaled(3.5);
  const cellBarGap = scaled(1.5);
  const cellHeights = [scaled(4.5), scaled(7), scaled(10), scaled(13.5)];
  const cellRight = wifiCenterX - scaled(18);
  const cellStartX =
    cellRight - cellBarWidth * 4 - cellBarGap * (cellHeights.length - 1);
  const cellBottom = statusCenterY + scaled(6.75);
  for (let index = 0; index < cellHeights.length; index += 1) {
    const height = cellHeights[index];
    roundRect(
      context,
      cellStartX + index * (cellBarWidth + cellBarGap),
      cellBottom - height,
      cellBarWidth,
      height,
      scaled(1),
      scaled(1),
      scaled(1),
      scaled(1),
    );
    context.fill();
  }

  context.textAlign = "left";
  context.textBaseline = "alphabetic";
}

function wrapMessage(
  context: CanvasRenderingContext2D,
  text: string,
  maxTextWidth: number,
) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width > maxTextWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawContactHeader(
  context: CanvasRenderingContext2D,
  avatarImage?: HTMLImageElement,
) {
  const avatarCenterX = WIDTH / 2;
  const avatarCenterY = scaled(126);
  const avatarRadius = scaled(27);

  context.save();
  context.beginPath();
  context.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, Math.PI * 2);
  context.clip();
  context.fillStyle = BRAND_COLORS.orange;
  context.fillRect(
    avatarCenterX - avatarRadius,
    avatarCenterY - avatarRadius,
    avatarRadius * 2,
    avatarRadius * 2,
  );
  if (avatarImage?.complete && avatarImage.naturalWidth > 0) {
    // The square brand asset sits on the same orange so the circular crop keeps
    // a clean, intentional margin around the white face.
    const inset = scaled(6);
    context.drawImage(
      avatarImage,
      avatarCenterX - avatarRadius + inset,
      avatarCenterY - avatarRadius + inset,
      avatarRadius * 2 - inset * 2,
      avatarRadius * 2 - inset * 2,
    );
  }
  context.restore();

  context.fillStyle = BRAND_COLORS.black;
  context.font = `700 ${scaled(16)}px Inter, -apple-system, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "top";
  context.fillText("Eliza", avatarCenterX, scaled(158));
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
}

function drawComposer(context: CanvasRenderingContext2D) {
  const inputBarY = HEIGHT - scaled(50);
  context.strokeStyle = "#e5e5ea";
  context.lineWidth = scaled(0.5);
  context.beginPath();
  context.moveTo(0, HEIGHT - scaled(58));
  context.lineTo(WIDTH, HEIGHT - scaled(58));
  context.stroke();

  context.fillStyle = "#007AFF";
  context.beginPath();
  context.arc(scaled(26), inputBarY + scaled(18), scaled(15), 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = BRAND_COLORS.white;
  context.lineWidth = scaled(2.5);
  context.beginPath();
  context.moveTo(scaled(19), inputBarY + scaled(18));
  context.lineTo(scaled(33), inputBarY + scaled(18));
  context.moveTo(scaled(26), inputBarY + scaled(11));
  context.lineTo(scaled(26), inputBarY + scaled(25));
  context.stroke();

  const inputX = scaled(52);
  const inputWidth = WIDTH - scaled(64);
  const inputHeight = scaled(36);
  context.strokeStyle = "#c7c7cc";
  context.lineWidth = scaled(1);
  pill(context, inputX, inputBarY, inputWidth, inputHeight);
  context.stroke();

  context.fillStyle = "#c7c7cc";
  context.font = `400 ${scaled(16)}px Inter, -apple-system, system-ui, sans-serif`;
  context.textAlign = "left";
  context.fillText("iMessage", inputX + scaled(16), inputBarY + scaled(23));

  const homeIndicatorWidth = scaled(134);
  context.fillStyle = BRAND_COLORS.black;
  roundRect(
    context,
    (WIDTH - homeIndicatorWidth) / 2,
    HEIGHT - scaled(10),
    homeIndicatorWidth,
    scaled(5),
    scaled(2.5),
    scaled(2.5),
    scaled(2.5),
    scaled(2.5),
  );
  context.fill();
}

export function getMessageCount(): number {
  return MESSAGES.length;
}

export function renderChatToCanvas(
  targetCanvas: HTMLCanvasElement | undefined,
  visibleCount: number,
  avatarImage?: HTMLImageElement,
  lastMessageProgress = 1,
): HTMLCanvasElement {
  const canvas = targetCanvas ?? document.createElement("canvas");
  if (canvas.width !== WIDTH) canvas.width = WIDTH;
  if (canvas.height !== HEIGHT) canvas.height = HEIGHT;
  const context = get2dContext(canvas);
  context.clearRect(0, 0, WIDTH, HEIGHT);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const screenRadius = scaled(60);
  context.save();
  roundRect(
    context,
    0,
    0,
    WIDTH,
    HEIGHT,
    screenRadius,
    screenRadius,
    screenRadius,
    screenRadius,
  );
  context.clip();
  context.fillStyle = BRAND_COLORS.white;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  const now = new Date();
  const statusTime = now.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const separatorY = scaled(189);

  if (visibleCount >= 1) {
    const dateProgress =
      visibleCount === 1 && lastMessageProgress < 1 ? lastMessageProgress : 1;
    context.save();
    context.globalAlpha = dateProgress;
    context.fillStyle = "#8e8e93";
    context.font = `400 ${scaled(13)}px Inter, -apple-system, system-ui, sans-serif`;
    context.textAlign = "center";
    context.fillText(
      `Today ${statusTime}`,
      WIDTH / 2,
      separatorY + scaled(20) + scaled(10) * (1 - dateProgress),
    );
    context.restore();
  }

  let messageY = separatorY + scaled(32);
  const messageFontSize = scaled(16);
  const messageFont = `400 ${messageFontSize}px Inter, -apple-system, system-ui, sans-serif`;
  const maxBubbleWidth = WIDTH * 0.7;
  const horizontalPadding = scaled(14);
  const verticalPadding = scaled(10);
  const horizontalMargin = scaled(14);
  const lineHeight = scaled(21);
  const count = Math.min(visibleCount, MESSAGES.length);

  for (let index = 0; index < count; index += 1) {
    const message = MESSAGES[index];
    const isUser = message.from === "user";
    const isLast = index === count - 1 && lastMessageProgress < 1;
    context.font = messageFont;
    const lines = wrapMessage(
      context,
      message.text,
      maxBubbleWidth - horizontalPadding * 2,
    );
    const bubbleWidth = Math.min(
      maxBubbleWidth,
      Math.max(...lines.map((line) => context.measureText(line).width)) +
        horizontalPadding * 2,
    );
    const bubbleHeight = lines.length * lineHeight + verticalPadding * 2;
    const bubbleX = isUser
      ? WIDTH - horizontalMargin - bubbleWidth
      : horizontalMargin;
    const slideOffset = isLast ? scaled(30) * (1 - lastMessageProgress) : 0;
    const scale = isLast ? 0.7 + 0.3 * lastMessageProgress : 1;

    context.save();
    context.globalAlpha = isLast ? lastMessageProgress : 1;
    if (isLast) {
      const originX = isUser ? bubbleX + bubbleWidth : bubbleX;
      const originY = messageY + bubbleHeight + slideOffset;
      context.translate(originX, originY);
      context.scale(scale, scale);
      context.translate(-originX, -originY);
    }

    context.save();
    context.shadowColor = "rgba(0,0,0,0.06)";
    context.shadowBlur = scaled(4);
    context.shadowOffsetY = scaled(1);
    context.fillStyle = isUser ? "#007AFF" : "#ebebed";
    drawBubble(
      context,
      bubbleX,
      messageY + slideOffset,
      bubbleWidth,
      bubbleHeight,
      isUser,
    );
    context.restore();

    context.fillStyle = isUser ? BRAND_COLORS.white : BRAND_COLORS.black;
    context.font = isUser
      ? `200 ${messageFontSize}px Inter, -apple-system, system-ui, sans-serif`
      : messageFont;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      context.fillText(
        lines[lineIndex],
        bubbleX + horizontalPadding,
        messageY +
          slideOffset +
          verticalPadding +
          scaled(13) +
          lineIndex * lineHeight,
      );
    }
    context.restore();
    messageY += bubbleHeight + scaled(10);
  }

  const headerBottom = separatorY + scaled(60);
  const headerGradient = context.createLinearGradient(0, 0, 0, headerBottom);
  headerGradient.addColorStop(0, "rgba(255,255,255,0.98)");
  headerGradient.addColorStop(0.65, "rgba(255,255,255,0.78)");
  headerGradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = headerGradient;
  context.fillRect(0, 0, WIDTH, headerBottom);

  drawStatusBar(context);
  drawContactHeader(context, avatarImage);
  drawComposer(context);
  context.restore();
  return canvas;
}
