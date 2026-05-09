import {
  animated,
  to,
  useSpring,
  useSprings,
  useTrail,
} from "@react-spring/web";
import { useDrag } from "@use-gesture/react";
import { getCountries, getCountryCallingCode } from "libphonenumber-js";
import type {
  ButtonHTMLAttributes,
  ComponentType,
  HTMLAttributes,
  SVGProps,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import BlobButton from "@/components/BlobButton";
import { ElizaLogo } from "@/components/brand/eliza-logo";
import ModelB, { type ModelBHandle } from "@/components/ModelViewers/ModelB";
import ShaderBackground from "@/components/ShaderBackground/ShaderBackground";
import VideoCall from "@/components/VideoCall";
import { ELIZA_PHONE_NUMBER } from "@/lib/contact";
import type { SpringAnimatedStyle } from "@/lib/spring-types";

type AnimatedHtmlProps<T extends HTMLElement> = Omit<
  HTMLAttributes<T>,
  "style"
> & {
  style?: SpringAnimatedStyle;
};
type AnimatedButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "style"
> & {
  style?: SpringAnimatedStyle;
};
type AnimatedSvgProps<T extends SVGElement> = Omit<SVGProps<T>, "style"> & {
  style?: SpringAnimatedStyle;
};

const AnimatedSpan = animated.span as ComponentType<
  AnimatedHtmlProps<HTMLSpanElement>
>;
const AnimatedDiv = animated.div as ComponentType<
  AnimatedHtmlProps<HTMLDivElement>
>;
const AnimatedButton = animated.button as ComponentType<AnimatedButtonProps>;
const AnimatedSvg = animated.svg as ComponentType<
  AnimatedSvgProps<SVGSVGElement>
>;
const AnimatedG = animated.g as ComponentType<AnimatedSvgProps<SVGGElement>>;

// Get all countries from libphonenumber-js
const COUNTRY_CODES = getCountries();

// Country name mapping (static to avoid hydration mismatch)
const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  DE: "Germany",
  FR: "France",
  ES: "Spain",
  IT: "Italy",
  NL: "Netherlands",
  BE: "Belgium",
  AT: "Austria",
  CH: "Switzerland",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  IE: "Ireland",
  PT: "Portugal",
  PL: "Poland",
  CZ: "Czech Republic",
  GR: "Greece",
  RU: "Russia",
  CN: "China",
  JP: "Japan",
  KR: "South Korea",
  IN: "India",
  BR: "Brazil",
  MX: "Mexico",
  AR: "Argentina",
  ZA: "South Africa",
  EG: "Egypt",
  NG: "Nigeria",
  AE: "United Arab Emirates",
  SA: "Saudi Arabia",
  IL: "Israel",
  TR: "Turkey",
  TH: "Thailand",
  SG: "Singapore",
  MY: "Malaysia",
  ID: "Indonesia",
  PH: "Philippines",
  VN: "Vietnam",
  NZ: "New Zealand",
};

function getCountryName(code: string): string {
  return COUNTRY_NAMES[code] || code;
}

// Convert country code to flag emoji (e.g., "US" -> 🇺🇸)
function getCountryFlag(countryCode: string): string {
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

// Build COUNTRIES array dynamically from all countries
const COUNTRIES = COUNTRY_CODES.map((code) => {
  let dialCode = "1";
  try {
    dialCode = getCountryCallingCode(code);
  } catch {
    // fallback
  }
  return {
    code,
    flag: getCountryFlag(code),
    name: getCountryName(code),
    dial: `+${dialCode}`,
    placeholder: "000 000 0000", // Generic placeholder
  };
}).sort((a, b) => a.name.localeCompare(b.name));

type Platform = "imessage" | "telegram" | "discord" | "try";

const INTRO_DELAY = 1000;
const PLATFORMS: Platform[] = ["imessage", "telegram", "discord", "try"];
const VERIFY_CODE_INPUT_KEYS = [
  "verify-0",
  "verify-1",
  "verify-2",
  "verify-3",
  "verify-4",
  "verify-5",
];

function IMessageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <title>iMessage</title>
      <path d="M12 2C6.477 2 2 5.813 2 10.5c0 2.592 1.392 4.912 3.57 6.462-.18 1.29-.612 2.842-1.57 4.038 2.16-.4 3.87-1.2 4.925-1.87A11.7 11.7 0 0012 19.5c5.523 0 10-3.813 10-8.5S17.523 2 12 2z" />
    </svg>
  );
}

function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <title>Telegram</title>
      <path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <title>Discord</title>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

function AnimatedLetters({
  text,
  show,
  delay = 0,
}: {
  text: string;
  show: boolean;
  delay?: number;
}) {
  const letterCounts = new Map<string, number>();
  const letters = text.split("").map((char) => {
    const count = letterCounts.get(char) ?? 0;
    letterCounts.set(char, count + 1);
    return { char, key: `${char}-${count}` };
  });
  const trail = useTrail(letters.length, {
    opacity: show ? 1 : 0,
    y: show ? 0 : -4,
    from: { opacity: 0, y: -4 },
    delay: show ? delay : 0,
    config: { mass: 0.3, tension: 450, friction: 28 },
  });

  return (
    <>
      {letters.map(({ char, key }, i) => {
        const style = trail[i];
        if (!style) return null;
        return (
          <AnimatedSpan
            key={key}
            style={{
              opacity: style.opacity,
              transform: style.y.to((v) => `translateY(${v}px)`),
              display: "inline-block",
            }}
          >
            {char === " " ? "\u00A0" : char}
          </AnimatedSpan>
        );
      })}
    </>
  );
}

export default function Leaderboard() {
  const navigate = useNavigate();
  const modelRef = useRef<ModelBHandle>(null);
  const [platform, setPlatform] = useState<Platform>("imessage");
  const [tryPlatform, setTryPlatform] = useState<Platform>("imessage");
  const [showUI, setShowUI] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  const [tryInput, setTryInput] = useState("");
  const [loginMaxW, setLoginMaxW] = useState(440);
  const [loginBottom, setLoginBottom] = useState(240);
  const [introSvgH, setIntroSvgH] = useState(384);
  const [introPb, setIntroPb] = useState(122);
  const [measured, setMeasured] = useState(false);

  const [lSwapped, setLSwapped] = useState(false);
  const [lScaleSpring, lScaleApi] = useSpring(() => ({
    scale: 1,
    config: { mass: 1, tension: 120, friction: 8 },
  }));

  useEffect(() => {
    if (!measured) return;
    // Phase 1: scale up to 1.05 (0-500ms)
    lScaleApi.start({
      scale: 1.15,
      config: { duration: 500, easing: (t: number) => 1 - (1 - t) ** 3 },
    });
    // Phase 2: scale down to 0.8 (500-1000ms)
    const t1 = setTimeout(() => {
      lScaleApi.start({
        scale: 0.85,
        config: { mass: 1, tension: 200, friction: 12 },
      });
    }, 500);
    // Phase 3: swap #l -> #fl at 800ms, scale back to 1.0
    const t2 = setTimeout(() => {
      setLSwapped(true);
      lScaleApi.start({
        scale: 1,
        config: { mass: 1, tension: 200, friction: 12 },
      });
    }, 800);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [measured, lScaleApi]);

  // Whole SVG scales down from larger to final size
  const svgScaleSpring = useSpring({
    scale: measured ? 1 : 1.3,
    config: { mass: 1, tension: 20, friction: 20 },
  });

  // #i1 (dot) -- pops in first, bouncier
  const i1Spring = useSpring({
    scale: measured ? 1 : 0,
    config: { mass: 0.8, tension: 250, friction: 10 },
    delay: 100,
  });
  // #i2 (body) -- scales up after dot
  const i2Spring = useSpring({
    scale: measured ? 1 : 0,
    config: { mass: 1, tension: 200, friction: 12 },
    delay: 250,
  });

  // scaleX squeeze/expand to swap #i -> #fi
  const [iSwapped, setISwapped] = useState(false);
  const [iSquashSpring, iSquashApi] = useSpring(() => ({
    scaleX: 1,
    scaleY: 1,
    config: { mass: 1, tension: 200, friction: 18 },
  }));

  useEffect(() => {
    if (!measured) return;
    // Wait for entrance animations to settle, then squeeze X / stretch Y
    const t1 = setTimeout(() => {
      iSquashApi.start({
        scaleX: 0,
        scaleY: 1.6,
        config: { duration: 250, easing: (t: number) => t * t * t },
      });
    }, 600);
    // At peak squash, swap and expand back (300ms later)
    const t2 = setTimeout(() => {
      setISwapped(true);
      iSquashApi.start({
        scaleX: 1,
        scaleY: 1,
        config: { mass: 1.2, tension: 180, friction: 10 },
      });
    }, 850);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [measured, iSquashApi]);

  // #e splatter entrance -> jitter -> shake-to-still swap to #fe
  const eDisplaceRef = useRef<SVGFEDisplacementMapElement>(null);
  const [eSwapped, setESwapped] = useState(false);

  useEffect(() => {
    if (!measured) return;
    let raf: number;
    let t0 = performance.now();

    // Phase 1: splatter in (800 -> 14) over 700ms
    const phase1 = () => {
      const elapsed = performance.now() - t0;
      const progress = Math.min(elapsed / 400, 1);
      const s = 1 - (1 - progress) ** 3;
      const scale = 800 + (14 - 800) * s;
      eDisplaceRef.current?.setAttribute("scale", String(scale));
      if (progress < 1) {
        raf = requestAnimationFrame(phase1);
      }
      // Phase 1 done -- jitter stays at 14 via seed animation, wait then ramp up
    };
    raf = requestAnimationFrame(phase1);

    // Phase 2: ramp jitter up (14 -> 150) over 200ms
    const t1 = setTimeout(() => {
      t0 = performance.now();
      const phase2 = () => {
        const elapsed = performance.now() - t0;
        const progress = Math.min(elapsed / 200, 1);
        const s = progress * progress; // ease-in
        const scale = 14 + (150 - 14) * s;
        eDisplaceRef.current?.setAttribute("scale", String(scale));
        if (progress < 1) {
          raf = requestAnimationFrame(phase2);
        } else {
          // At peak chaos -- snap to clean #fe
          setESwapped(true);
        }
      };
      raf = requestAnimationFrame(phase2);
    }, 500);

    return () => {
      clearTimeout(t1);
      cancelAnimationFrame(raf);
    };
  }, [measured]);

  // #a blur entrance with bounce + swap to #fa at peak + scale down
  const aBlurRef = useRef<SVGFEGaussianBlurElement>(null);
  const faScaleRef = useRef<SVGGElement>(null);
  const [aSwapped, setASwapped] = useState(false);

  useEffect(() => {
    if (!measured) return;
    let raf: number;
    let t0 = performance.now();
    const blurDuration = 600;
    const startBlur = 40;
    const bouncePeak = 25;
    const bounceDuration = 400;
    // #fa scale: 1.2 -> 1 from bottom-right origin (988, 372)
    const ox = 988,
      oy = 372;
    const startScale = 1.5;

    // Phase 1: blur 40 -> 0
    const phase1 = () => {
      const elapsed = performance.now() - t0;
      const progress = Math.min(elapsed / blurDuration, 1);
      const ease = 1 - (1 - progress) ** 3;
      aBlurRef.current?.setAttribute(
        "stdDeviation",
        String(startBlur * (1 - ease)),
      );
      if (progress < 1) raf = requestAnimationFrame(phase1);
    };
    raf = requestAnimationFrame(phase1);

    // Phase 2: bounce blur 0 -> 25 -> 0, swap at peak, scale #fa 1.2 -> 1
    const t1 = setTimeout(() => {
      t0 = performance.now();
      let swapped = false;
      const phase2 = () => {
        const elapsed = performance.now() - t0;
        const progress = Math.min(elapsed / bounceDuration, 1);
        const blur = bouncePeak * Math.sin(progress * Math.PI);
        aBlurRef.current?.setAttribute("stdDeviation", String(blur));
        // Swap at the peak (halfway)
        if (!swapped && progress >= 0.5) {
          swapped = true;
          setASwapped(true);
        }
        // Scale #fa from 1.2 -> 1 (ease-out cubic, starts from swap point)
        if (progress >= 0.5) {
          const scaleProgress = Math.min((progress - 0.5) / 0.5, 1);
          const ease = 1 - (1 - scaleProgress) ** 3;
          const s = startScale + (1 - startScale) * ease;
          faScaleRef.current?.setAttribute(
            "transform",
            `translate(${ox}, ${oy}) scale(${s}) translate(${-ox}, ${-oy})`,
          );
        }
        if (progress < 1) raf = requestAnimationFrame(phase2);
      };
      raf = requestAnimationFrame(phase2);
    }, blurDuration);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t1);
    };
  }, [measured]);

  // Left-to-right mask wipe to swap #z -> #fz
  const clipOldRef = useRef<SVGPolygonElement>(null);
  const clipNewRef = useRef<SVGPolygonElement>(null);

  useEffect(() => {
    if (!measured) return;
    const startDelay = 700;
    const duration = 800;
    let raf: number;
    const t = setTimeout(() => {
      const t0 = performance.now();
      const tick = () => {
        const elapsed = performance.now() - t0;
        const progress = Math.min(elapsed / duration, 1);
        // ease-out cubic
        const w = 1 - (1 - progress) ** 3;
        const wipeX = 315 + w * 475;
        clipOldRef.current?.setAttribute(
          "points",
          `${wipeX},380 ${wipeX + 200},80 790,80 790,380`,
        );
        clipNewRef.current?.setAttribute(
          "points",
          `515,380 515,80 ${wipeX + 200},80 ${wipeX},380`,
        );
        if (progress < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, startDelay);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, [measured]);

  useEffect(() => {
    const update = () => {
      const h = window.innerHeight;
      const w = Math.round(0.478 * h - 22);
      const b = Math.round(0.48 * h - 240);
      const svgH = Math.round(0.3303 * h - 0.27);
      const pb = Math.round(0.09155 * h - 25.12);
      console.log(
        `[debug] screenHeight=${h} maxWidth=${w} bottom=${b} svgH=${svgH} pb=${pb}`,
      );
      setLoginMaxW(w);
      setLoginBottom(b);
      setIntroSvgH(svgH);
      setIntroPb(pb);
      setMeasured(true);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const [waiting, setWaiting] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const toggleVoiceInput = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognitionRef.current = recognition;

    recognition.onstart = () => setListening(true);
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognition.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setTryInput(transcript);
    };
    recognition.start();
  }, [listening]);

  const [selectedCountry, setSelectedCountry] = useState("US");
  const country =
    COUNTRIES.find((c) => c.code === selectedCountry) ?? COUNTRIES[0];
  const [phoneDigits, setPhoneDigits] = useState("");

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, []);

  const formatPhone = useCallback((digits: string, pattern: string) => {
    let result = "";
    let d = 0;
    for (let i = 0; i < pattern.length && d < digits.length; i++) {
      if (pattern[i] === "0") {
        result += digits[d++];
      } else {
        result += pattern[i];
      }
    }
    return result;
  }, []);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherSettled, setSwitcherSettled] = useState(true);
  const switcherOpenRef = useRef(false);
  useEffect(() => {
    switcherOpenRef.current = switcherOpen;
  }, [switcherOpen]);
  const [loginSettled, setLoginSettled] = useState(false);
  const [loginStep, setLoginStep] = useState<"phone" | "verify">("phone");
  const [submittedPhone, setSubmittedPhone] = useState("");
  const [verifyCode, setVerifyCode] = useState(["", "", "", "", "", ""]);
  const verifyInputsRef = useRef<(HTMLInputElement | null)[]>([]);
  const [resendCountdown, setResendCountdown] = useState(60);
  const resendIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleVideoClick = useCallback(() => setShowVideo((v) => !v), []);
  const handleLoginClick = useCallback(() => {
    setLoginSettled(false);
    setSwitcherOpen((prev) => !prev);
    setSwitcherSettled(false);
  }, []);
  const handleSwitcherDone = () => {
    setSwitcherSettled(true);
    if (!switcherOpenRef.current) {
      setLoginStep("phone");
      setPhoneDigits("");
      setVerifyCode(["", "", "", "", "", ""]);
      if (resendIntervalRef.current) clearInterval(resendIntervalRef.current);
    }
  };

  const startResendCountdown = useCallback(() => {
    setResendCountdown(60);
    if (resendIntervalRef.current) clearInterval(resendIntervalRef.current);
    resendIntervalRef.current = setInterval(() => {
      setResendCountdown((prev) => {
        if (prev <= 1) {
          if (resendIntervalRef.current)
            clearInterval(resendIntervalRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (resendIntervalRef.current) clearInterval(resendIntervalRef.current);
    };
  }, []);

  const tabBarHideSpring = useSpring({
    opacity: switcherOpen ? 0 : 1,
    scale: switcherOpen ? 0.95 : 1,
    y: switcherOpen ? 4 : 0,
    config: switcherOpen
      ? { mass: 1, tension: 200, friction: 28 }
      : { mass: 1, tension: 120, friction: 28 },
  });

  useEffect(() => {
    const id1 = setTimeout(() => setIntroDone(true), INTRO_DELAY + 680);
    const id2 = setTimeout(() => setShowUI(true), INTRO_DELAY + 800);
    return () => {
      clearTimeout(id1);
      clearTimeout(id2);
    };
  }, []);

  // Staggered tab bar appear animations: bg -> icons -> indicator
  const tabBarBgSpring = useSpring({
    reveal: showUI ? 120 : -20,
    delay: showUI ? 200 : 0,
    config: { tension: 60, friction: 30 },
  });

  const iconSprings = useSprings(
    3,
    [0, 1, 2].map((i) => ({
      opacity: showUI ? 1 : 0,
      scale: showUI ? 1 : 0.8,
      from: { opacity: 0, scale: 0.8 },
      delay: showUI ? 500 + i * 150 : 0,
      config: { mass: 0.3, tension: 450, friction: 28 },
    })),
  );

  const indicatorAppearSpring = useSpring({
    reveal: showUI ? 120 : -20,
    delay: showUI ? 800 : 0,
    config: { tension: 60, friction: 30 },
  });

  const tryAppearSpring = useSpring({
    tryWidth: showUI ? 110 : 0,
    tryGap: showUI ? 12 : 0,
    tryOpacity: showUI ? 1 : 0,
    delay: showUI ? 800 : 0,
    config: { mass: 1.4, tension: 240, friction: 20 },
  });

  const tryBgSpring = useSpring({
    reveal: showUI ? 120 : -20,
    delay: showUI ? 800 : 0,
    config: { tension: 60, friction: 30 },
  });

  const isTry = platform === "try";
  const inputBarVisible = isTry && !switcherOpen && switcherSettled;
  const inputBarSpring = useSpring({
    opacity: inputBarVisible ? 1 : 0,
    y: inputBarVisible ? 0 : 40,
    config: inputBarVisible
      ? { mass: 1, tension: 160, friction: 12 }
      : { mass: 1, tension: 600, friction: 34 },
  });

  const handleSwitcherOpen = useCallback(() => setLoginSettled(true), []);

  const loginTitle =
    loginStep === "verify"
      ? "Enter your verification code"
      : "What's your phone number?";
  const loginSubtitle =
    loginStep === "verify" ? `Sent SMS to ${submittedPhone}` : undefined;

  const phoneBarVisible = switcherOpen && loginSettled && loginStep === "phone";
  const verifyBarVisible =
    switcherOpen && loginSettled && loginStep === "verify";

  const loginBarVisible = phoneBarVisible;
  const loginBarSpring = useSpring({
    opacity: loginBarVisible ? 1 : 0,
    y: loginBarVisible ? 0 : 40,
    scale: loginBarVisible ? 1 : 1,
    config: loginBarVisible
      ? { mass: 1, tension: 160, friction: 12 }
      : { mass: 1, tension: 600, friction: 34 },
  });

  const verifyBarSpring = useSpring({
    opacity: verifyBarVisible ? 1 : 0,
    y: verifyBarVisible ? 0 : 40,
    config: verifyBarVisible
      ? { mass: 1, tension: 160, friction: 12 }
      : { mass: 1, tension: 600, friction: 34 },
  });

  const platforms = PLATFORMS;
  const prevIndex = useRef(platforms.indexOf(platform));
  const [squishing, setSquishing] = useState(false);
  const [barBounceLeft, setBarBounceLeft] = useState(false);
  const [barBounceRight, setBarBounceRight] = useState(false);
  const [tryBounce, setTryBounce] = useState<false | "enter" | "leave">(false);

  const targetIndex = platforms.indexOf(platform);

  const changePlatform = useCallback((newPlatform: Platform) => {
    const newIndex = platforms.indexOf(newPlatform);
    const oldIndex = prevIndex.current;
    if (newIndex === oldIndex) return;

    setPlatform(newPlatform);
    if (newPlatform !== "try") setTryPlatform(newPlatform);
    setSquishing(true);
    if (newPlatform !== "try") {
      modelRef.current?.spin(newIndex > oldIndex ? -1 : 1);
      setTimeout(() => modelRef.current?.restartMessages(), 200);
    }
    setTimeout(() => {
      setSquishing(false);
      prevIndex.current = newIndex;
    }, 100);

    if (newIndex === 0) {
      setBarBounceLeft(true);
      setTimeout(() => setBarBounceLeft(false), 150);
    }
    if (newIndex === 2) {
      setBarBounceRight(true);
      setTimeout(() => setBarBounceRight(false), 150);
    }
    if (newIndex === 3) {
      setTryBounce("enter");
      setTimeout(() => setTryBounce(false), 150);
    } else if (oldIndex === 3) {
      setTryBounce("leave");
      setTimeout(() => setTryBounce(false), 150);
    }
  }, []);

  // Indicator left offsets relative to the flex wrapper
  // 0-2: barBorder(1) + barPad(6) + index * 52
  // 3: barWidth(166) + gap(12) + (110-98)/2 = 184
  const indicatorPositions = [7, 59, 111, 184];

  const indicatorSpring = useSpring({
    left: targetIndex === 3 ? 184 : indicatorPositions[targetIndex],
    width: targetIndex === 3 ? 98 : 48,
    scaleY: squishing ? 0.75 : 1,
    config: { mass: 1, tension: 340, friction: 20 },
  });

  const barSpring = useSpring({
    paddingLeft: barBounceLeft ? 32 : 6,
    paddingRight: barBounceRight ? 28 : 6,
    config: { mass: 1, tension: 340, friction: 20 },
  });

  const trySpring = useSpring({
    width: tryBounce === "enter" ? 140 : tryBounce === "leave" ? 100 : 110,
    height: tryBounce === "enter" ? 63 : tryBounce === "leave" ? 57 : 60,
    config: { mass: 1, tension: 340, friction: 20 },
  });

  const switchPlatform = useCallback(
    (dir: -1 | 1) => {
      const idx = platforms.indexOf(platform);
      const next = idx - dir; // swipe left (dir=-1) -> next, swipe right (dir=1) -> prev
      if (next < 0 || next > 3) return;
      changePlatform(platforms[next]);
    },
    [platform, changePlatform],
  );

  const bind = useDrag(
    ({ swipe: [sx], movement: [mx], last }) => {
      if (switcherOpen) return;
      if (!last) return;
      if (sx !== 0) {
        switchPlatform(sx as -1 | 1);
      } else if (Math.abs(mx) > 50) {
        switchPlatform(mx < 0 ? -1 : 1);
      }
    },
    {
      axis: "x",
      swipe: { velocity: 0.3, distance: 30 },
      filterTaps: true,
    },
  );

  return (
    <div {...bind()} className="min-h-screen" style={{ touchAction: "pan-y" }}>
      <ShaderBackground />
      <div
        className="fixed inset-0 pointer-events-none mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundRepeat: "repeat",
          backgroundSize: "256px 256px",
        }}
      />
      <ModelB
        ref={modelRef}
        tryActive={platform === "try"}
        switcherOpen={switcherOpen}
        onWaitingChange={setWaiting}
        onVideoClick={handleVideoClick}
        onBackClick={handleLoginClick}
        onSwitcherDone={handleSwitcherDone}
        onSwitcherOpen={handleSwitcherOpen}
        loginTitle={loginTitle}
        loginSubtitle={loginSubtitle}
        platform={platform}
        introDelayMs={INTRO_DELAY}
      />
      <div className="relative z-30 pointer-events-none">
        <header className="flex items-center justify-between p-5 pointer-events-auto">
          <button
            type="button"
            onClick={() => {
              if (switcherOpen) {
                setLoginSettled(false);
                setSwitcherOpen(false);
              }
            }}
            disabled={!switcherOpen}
            aria-label={switcherOpen ? "Close platform switcher" : "Eliza"}
            className={`appearance-none bg-transparent border-0 p-0 ${
              switcherOpen ? "cursor-pointer" : "cursor-default"
            }`}
          >
            <ElizaLogo className="h-8 md:h-10 lg:h-12 w-auto" />
          </button>
          <nav className="flex items-center gap-4">
            <BlobButton
              href={`sms:${ELIZA_PHONE_NUMBER}?body=Hi%20Eliza`}
              onClick={() => {
                // Try to open native Messages, fallback to /get-started if it doesn't work
                const fallbackTimeout = setTimeout(() => {
                  navigate("/get-started");
                }, 1500);

                // If page becomes hidden (native app opened), cancel fallback
                const handleVisibilityChange = () => {
                  if (document.hidden) {
                    clearTimeout(fallbackTimeout);
                    document.removeEventListener(
                      "visibilitychange",
                      handleVisibilityChange,
                    );
                  }
                };
                document.addEventListener(
                  "visibilitychange",
                  handleVisibilityChange,
                );

                // Cleanup after 2 seconds regardless
                setTimeout(() => {
                  document.removeEventListener(
                    "visibilitychange",
                    handleVisibilityChange,
                  );
                }, 2000);
              }}
              show={showUI}
            >
              <AnimatedLetters text="Get Started" show={showUI} delay={80} />
            </BlobButton>
          </nav>
        </header>
        <main className="flex w-full max-w-3xl mx-auto flex-col items-center justify-center px-16"></main>
        <div className="fixed top-[14%] left-1/2 -translate-x-1/2 pointer-events-auto">
          <AnimatedDiv
            style={{
              opacity: tabBarHideSpring.opacity,
              transform: to(
                [tabBarHideSpring.scale, tabBarHideSpring.y],
                (sc, y) => `scale(${sc}) translateY(${y}px)`,
              ),
              pointerEvents: switcherOpen ? "none" : "auto",
            }}
          >
            <AnimatedDiv
              className="relative isolate flex items-center"
              style={{ gap: tryAppearSpring.tryGap }}
            >
              {/* Sliding indicator -- in wrapper so it can travel between bar and Try */}
              <AnimatedDiv
                className="absolute z-1 h-12 bg-white/30 backdrop-blur-sm border border-white/60 rounded-full"
                style={{
                  ...indicatorSpring,
                  top: 7,
                  WebkitMaskImage: indicatorAppearSpring.reveal.to(
                    (v) =>
                      `linear-gradient(to bottom right, rgba(0,0,0,1) ${v - 20}%, rgba(0,0,0,0) ${v + 20}%)`,
                  ),
                  maskImage: indicatorAppearSpring.reveal.to(
                    (v) =>
                      `linear-gradient(to bottom right, rgba(0,0,0,1) ${v - 20}%, rgba(0,0,0,0) ${v + 20}%)`,
                  ),
                }}
              />
              <AnimatedDiv
                className="relative flex items-center gap-1 rounded-full py-1.5 border border-transparent"
                style={barSpring}
              >
                {/* Glass bg -- separated so bar doesn't create a stacking context */}
                <AnimatedDiv
                  className="absolute inset-0 rounded-full bg-white/30 backdrop-blur border border-white/60"
                  style={{
                    WebkitMaskImage: tabBarBgSpring.reveal.to(
                      (v) =>
                        `linear-gradient(to bottom right, rgba(0,0,0,1) ${v - 20}%, rgba(0,0,0,0) ${v + 20}%)`,
                    ),
                    maskImage: tabBarBgSpring.reveal.to(
                      (v) =>
                        `linear-gradient(to bottom right, rgba(0,0,0,1) ${v - 20}%, rgba(0,0,0,0) ${v + 20}%)`,
                    ),
                  }}
                />
                {(["imessage", "telegram", "discord"] as Platform[]).map(
                  (p, i) => (
                    <AnimatedButton
                      key={p}
                      onClick={() => changePlatform(p)}
                      className="relative z-20 flex items-center justify-center size-12 rounded-full cursor-pointer"
                      style={{
                        opacity: iconSprings[i].opacity,
                        scale: iconSprings[i].scale,
                      }}
                    >
                      {p === "imessage" && (
                        <IMessageIcon className="w-7 h-7 text-[#34C759]" />
                      )}
                      {p === "telegram" && (
                        <TelegramIcon className="w-7 h-7 text-[#2AABEE]" />
                      )}
                      {p === "discord" && (
                        <DiscordIcon className="w-7 h-7 text-[#5865F2]" />
                      )}
                    </AnimatedButton>
                  ),
                )}
              </AnimatedDiv>
              <AnimatedDiv
                className="relative overflow-hidden"
                style={{
                  width: to(
                    [trySpring.width, tryAppearSpring.tryWidth],
                    (bounce, entry) => Math.max(bounce, entry),
                  ),
                  height: trySpring.height,
                }}
              >
                {/* Try bg -- z-0, below the indicator */}
                <AnimatedDiv
                  className="absolute right-0 top-0 rounded-full border border-white/60 bg-white/30 backdrop-blur"
                  style={{
                    width: trySpring.width,
                    height: trySpring.height,
                    WebkitMaskImage: tryBgSpring.reveal.to(
                      (v) =>
                        `linear-gradient(to bottom right, rgba(0,0,0,1) ${v - 20}%, rgba(0,0,0,0) ${v + 20}%)`,
                    ),
                    maskImage: tryBgSpring.reveal.to(
                      (v) =>
                        `linear-gradient(to bottom right, rgba(0,0,0,1) ${v - 20}%, rgba(0,0,0,0) ${v + 20}%)`,
                    ),
                  }}
                />
                {/* Try text -- z-[2], above the indicator (z-[1]) */}
                <AnimatedButton
                  onClick={() => navigate("/get-started")}
                  className="relative z-2 flex items-center justify-center h-full w-full rounded-full text-neutral-900 font-semibold text-base whitespace-nowrap cursor-pointer"
                  style={{ opacity: tryAppearSpring.tryOpacity }}
                >
                  Try Now
                </AnimatedButton>
              </AnimatedDiv>
            </AnimatedDiv>
          </AnimatedDiv>
        </div>
      </div>
      {/* Try Now input bar */}
      <AnimatedDiv
        className={`fixed bottom-0 left-1/2 -translate-x-1/2 z-20 w-full  ${tryPlatform === "telegram" ? "px-2 pt-3 pb-3 bg-white" : tryPlatform === "discord" ? "px-2 pt-3 pb-3 bg-[#36393f] border-t border-[#202225]" : "px-5 pt-20 pb-6  bg-linear-to-b from-neutral-200/0 to-neutral-200/80"}`}
        style={{
          maxWidth: loginMaxW + 12,
          opacity: inputBarSpring.opacity,
          pointerEvents: inputBarVisible ? "auto" : "none",
          transform:
            tryPlatform === "telegram" || tryPlatform === "discord"
              ? inputBarSpring.y.to(
                  (y) => `perspective(600px) rotateX(5deg) translateY(${y}px)`,
                )
              : "perspective(600px) rotateX(5deg)",
          transformOrigin: "bottom center",
        }}
      >
        {tryPlatform === "telegram" || tryPlatform === "discord" ? (
          <div className="flex items-end gap-2">
            <div
              className={`flex-1 flex items-end rounded-[26px] border pl-5 pr-1.5 py-1.5 ${tryPlatform === "discord" ? "bg-[#40444b] border-[#40444b]" : tryPlatform === "telegram" ? "bg-white border-neutral-300" : "bg-white border-neutral-200"}`}
            >
              <textarea
                ref={textareaRef}
                rows={1}
                value={tryInput}
                onChange={(e) => {
                  setTryInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 320)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (tryInput.trim() && !waiting) {
                      if (listening) recognitionRef.current?.stop();
                      modelRef.current?.sendMessage(tryInput.trim());
                      setTryInput("");
                      if (textareaRef.current)
                        textareaRef.current.style.height = "auto";
                    }
                  }
                }}
                placeholder={
                  tryPlatform === "telegram"
                    ? "Message"
                    : tryPlatform === "discord"
                      ? "Message #general"
                      : ""
                }
                className={`flex-1 bg-transparent text-lg outline-none resize-none py-1.5 max-h-80 leading-snug scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] ${tryPlatform === "discord" ? "text-white placeholder-[#72767d] caret-white" : tryPlatform === "telegram" ? "text-black placeholder-neutral-400 caret-[#2AABEE]" : "text-black caret-green-600"}`}
              />
            </div>
            <button
              type="button"
              onClick={() => {
                if (tryInput.trim() && !waiting) {
                  if (listening) recognitionRef.current?.stop();
                  modelRef.current?.sendMessage(tryInput.trim());
                  setTryInput("");
                  if (textareaRef.current)
                    textareaRef.current.style.height = "auto";
                } else {
                  toggleVoiceInput();
                }
              }}
              aria-label={
                tryInput.trim() ? "Send message" : "Start voice input"
              }
              className={`shrink-0 flex items-center justify-center rounded-full cursor-pointer ${tryInput.trim() ? (waiting ? "size-12 bg-neutral-300 text-white" : tryPlatform === "discord" ? "size-12 text-[#5865F2]" : "size-12 text-[#2AABEE]") : listening ? (tryPlatform === "discord" ? "size-12 bg-[#5865F2] text-white" : "size-12 bg-[#2AABEE] text-white") : "size-12 text-neutral-400"}`}
            >
              {tryInput.trim() ? (
                tryPlatform === "telegram" ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="size-12"
                  >
                    <title>Telegram</title>
                    <path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="size-5"
                  >
                    <title>Send message</title>
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                )
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-6"
                >
                  <title>Voice input</title>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <path d="M12 19v4M8 23h8" />
                </svg>
              )}
            </button>
          </div>
        ) : (
          <AnimatedDiv
            className="flex items-end gap-3 bg-white/80 backdrop-blur border-2 border-white rounded-[26px] pl-5 pr-1.5 py-1.5"
            style={{
              transform: inputBarSpring.y.to((y) => `translateY(${y}px)`),
            }}
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={tryInput}
              onChange={(e) => {
                setTryInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 320)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (tryInput.trim() && !waiting) {
                    if (listening) recognitionRef.current?.stop();
                    modelRef.current?.sendMessage(tryInput.trim());
                    setTryInput("");
                    if (textareaRef.current)
                      textareaRef.current.style.height = "auto";
                  }
                }
              }}
              placeholder="Message Eliza..."
              className="flex-1 bg-transparent text-black placeholder-black/40 font-light text-lg outline-none resize-none py-1.5 max-h-80 leading-snug caret-blue-500 scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none]"
            />
            <button
              type="button"
              onClick={() => {
                if (tryInput.trim() && !waiting) {
                  if (listening) recognitionRef.current?.stop();
                  modelRef.current?.sendMessage(tryInput.trim());
                  setTryInput("");
                  if (textareaRef.current)
                    textareaRef.current.style.height = "auto";
                } else {
                  toggleVoiceInput();
                }
              }}
              aria-label={
                tryInput.trim() ? "Send message" : "Start voice input"
              }
              className={`shrink-0 flex items-center justify-center rounded-full mb-0.5 cursor-pointer ${tryInput.trim() ? (waiting ? "w-12 h-9 bg-neutral-300 text-white" : "w-12 h-9 bg-blue-500 text-white") : listening ? "w-12 h-9 bg-blue-500 text-white" : "w-9 h-9 text-black/40"}`}
            >
              {tryInput.trim() ? (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-5"
                >
                  <title>Send message</title>
                  <path d="M12 22V4M5 11l7-7 7 7" />
                </svg>
              ) : listening ? (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-5"
                >
                  <title>Voice input</title>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <path d="M12 19v4M8 23h8" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-5"
                >
                  <title>Voice input</title>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <path d="M12 19v4M8 23h8" />
                </svg>
              )}
            </button>
          </AnimatedDiv>
        )}
      </AnimatedDiv>
      {/* Login mode phone input + continue button */}
      <AnimatedDiv
        className="fixed left-1/2 -translate-x-1/2 z-20 w-full gap-4 px-8 flex flex-col "
        style={{
          bottom: loginBottom,
          maxWidth: loginMaxW,
          opacity: loginBarSpring.opacity,
          pointerEvents: loginBarVisible ? "auto" : "none",
          transform: to(
            [loginBarSpring.y, loginBarSpring.scale],
            (y, s) =>
              `perspective(600px) rotateX(5deg) translateY(${y}px) scale(${s})`,
          ),
          transformOrigin: "bottom center",
        }}
      >
        <div className="flex items-center gap-4 bg-neutral-200/50 rounded-3xl px-4 py-4">
          <div className="relative flex items-center gap-1.5 text-neutral-600 cursor-pointer">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-4"
            >
              <title>Select country</title>
              <path d="M6 9l6 6 6-6" />
            </svg>
            <span className="text-3xl leading-none">{country.flag}</span>
            <select
              value={selectedCountry}
              onChange={(e) => {
                setSelectedCountry(e.target.value);
                setPhoneDigits("");
              }}
              className="absolute inset-0 opacity-0 cursor-pointer"
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.flag} {c.name} ({c.dial})
                </option>
              ))}
            </select>
          </div>

          <input
            type="tel"
            value={formatPhone(phoneDigits, country.placeholder)}
            onChange={(e) => {
              const raw = e.target.value.replace(/\D/g, "");
              const maxDigits = country.placeholder.replace(/\D/g, "").length;
              setPhoneDigits(raw.slice(0, maxDigits));
            }}
            placeholder={country.placeholder}
            className="flex-1 bg-transparent text-black text-lg outline-none font-light"
          />
        </div>
        <button
          type="button"
          disabled={
            phoneDigits.length !== country.placeholder.replace(/\D/g, "").length
          }
          onClick={() => {
            if (
              phoneDigits.length ===
              country.placeholder.replace(/\D/g, "").length
            ) {
              setSubmittedPhone(
                `${country.dial} ${formatPhone(phoneDigits, country.placeholder)}`,
              );
              setLoginStep("verify");
              setPhoneDigits("");
              setVerifyCode(["", "", "", "", "", ""]);
              startResendCountdown();
              setTimeout(() => verifyInputsRef.current[0]?.focus(), 100);
            }
          }}
          className={`w-full rounded-3xl py-4 text-[17px] font-semibold transition-colors ${
            phoneDigits.length === country.placeholder.replace(/\D/g, "").length
              ? "bg-neutral-900 text-white hover:bg-black cursor-pointer"
              : "bg-neutral-300 text-neutral-500 cursor-not-allowed"
          }`}
        >
          Continue with phone
        </button>
      </AnimatedDiv>
      {/* Verification code input bar */}
      <AnimatedDiv
        className="fixed left-1/2 -translate-x-1/2 z-20 w-full gap-4 px-8 flex flex-col"
        style={{
          bottom: loginBottom - 36,
          maxWidth: loginMaxW,
          opacity: verifyBarSpring.opacity,
          pointerEvents: verifyBarVisible ? "auto" : "none",
          transform: verifyBarSpring.y.to(
            (y) => `perspective(600px) rotateX(5deg) translateY(${y}px)`,
          ),
          transformOrigin: "bottom center",
        }}
      >
        <div className="flex items-center gap-2">
          {VERIFY_CODE_INPUT_KEYS.map((key, i) => {
            const digit = verifyCode[i] ?? "";
            return (
              <input
                key={key}
                ref={(el) => {
                  verifyInputsRef.current[i] = el;
                }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, "");
                  if (!val && !digit) return;
                  const newCode = [...verifyCode];
                  newCode[i] = val.slice(-1);
                  setVerifyCode(newCode);
                  if (val && i < 5) {
                    verifyInputsRef.current[i + 1]?.focus();
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" && !digit && i > 0) {
                    const newCode = [...verifyCode];
                    newCode[i - 1] = "";
                    setVerifyCode(newCode);
                    verifyInputsRef.current[i - 1]?.focus();
                  }
                }}
                onPaste={(e) => {
                  e.preventDefault();
                  const pasted = e.clipboardData
                    .getData("text")
                    .replace(/\D/g, "")
                    .slice(0, 6);
                  if (!pasted) return;
                  const newCode = [...verifyCode];
                  for (let j = 0; j < pasted.length && i + j < 6; j++) {
                    newCode[i + j] = pasted[j];
                  }
                  setVerifyCode(newCode);
                  const focusIdx = Math.min(i + pasted.length, 5);
                  verifyInputsRef.current[focusIdx]?.focus();
                }}
                className="flex-1 min-w-0 aspect-square bg-neutral-200/50 rounded-xl text-center text-3xl font-semibold text-black outline-none focus:ring-2 focus:ring-neutral-400"
              />
            );
          })}
        </div>
        <button
          type="button"
          disabled={verifyCode.some((d) => !d)}
          className={`w-full rounded-3xl py-4 text-[17px] font-semibold transition-colors ${
            verifyCode.every((d) => d)
              ? "bg-neutral-900 text-white hover:bg-black cursor-pointer"
              : "bg-neutral-300 text-neutral-500 cursor-not-allowed"
          }`}
        >
          Verify
        </button>
        <p className="text-center text-sm text-neutral-500">
          {resendCountdown > 0 ? (
            <>
              Didn&apos;t receive a code? Resend in{" "}
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {resendCountdown}s
              </span>
            </>
          ) : (
            <>
              Didn&apos;t receive a code?{" "}
              <button
                type="button"
                onClick={startResendCountdown}
                className="text-neutral-900 font-medium underline cursor-pointer"
              >
                Resend
              </button>
            </>
          )}
        </p>
      </AnimatedDiv>
      <VideoCall visible={showVideo} onClose={() => setShowVideo(false)} />
      <AnimatedDiv
        className={`fixed inset-0 z-50 bg-white pointer-events-none flex items-center justify-center duration-100 ${
          introDone ? "opacity-0" : ""
        }`}
        style={{
          paddingBottom: introPb,
        }}
      >
        <AnimatedSvg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 -50 1100 500"
          className="intro-logo w-auto"
          style={{
            height: introSvgH,
            visibility: measured ? "visible" : "hidden",
            transform: svgScaleSpring.scale.to((s: number) => `scale(${s})`),
          }}
        >
          <defs>
            <linearGradient id="z-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#696eff" />
              <stop offset="100%" stopColor="#f8acff" />
            </linearGradient>
            <linearGradient id="z-grad2" x1="1" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f89b29" />
              <stop offset="100%" stopColor="#ff7ba1" />
            </linearGradient>
            <linearGradient id="l-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0068ff" />
              <stop offset="100%" stopColor="#00c8ff" />
            </linearGradient>
            <filter
              id="chrome"
              x="-5%"
              y="-5%"
              width="110%"
              height="110%"
              colorInterpolationFilters="sRGB"
            >
              <feGaussianBlur
                in="SourceAlpha"
                stdDeviation="12"
                result="bevel"
              />
              <feFlood floodColor="#ffffff" result="white" />
              <feComposite
                in="white"
                in2="SourceAlpha"
                operator="in"
                result="whiteShape"
              />
              <feGaussianBlur
                in="whiteShape"
                stdDeviation="30"
                result="envGlow"
              />
              <feFlood floodColor="#606060" result="dark" />
              <feComposite
                in="dark"
                in2="SourceAlpha"
                operator="in"
                result="darkShape"
              />
              <feBlend
                in="darkShape"
                in2="envGlow"
                mode="screen"
                result="envBase"
              />
              <feDiffuseLighting
                in="bevel"
                surfaceScale="8"
                diffuseConstant="1.1"
                lightingColor="#e0e0e0"
                result="diff"
              >
                <fePointLight x="500" y="30" z="300" />
              </feDiffuseLighting>
              <feComposite
                in="diff"
                in2="SourceAlpha"
                operator="in"
                result="diffClip"
              />
              <feBlend
                in="envBase"
                in2="diffClip"
                mode="multiply"
                result="body"
              />
              <feSpecularLighting
                in="bevel"
                surfaceScale="7"
                specularConstant="1.8"
                specularExponent="40"
                lightingColor="#ffffff"
                result="spec"
              >
                <fePointLight x="490" y="-30" z="350">
                  <animate
                    attributeName="x"
                    values="490;440;530;460;520;490"
                    dur="0.8s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="y"
                    values="-30;20;-70;10;-50;-30"
                    dur="0.7s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="z"
                    values="350;280;400;300;380;350"
                    dur="0.9s"
                    repeatCount="indefinite"
                  />
                </fePointLight>
              </feSpecularLighting>
              <feComposite
                in="spec"
                in2="SourceAlpha"
                operator="in"
                result="specClip"
              />
              <feBlend in="body" in2="specClip" mode="screen" result="lit" />
              <feComponentTransfer in="lit" result="final">
                <feFuncR
                  type="table"
                  tableValues="0.05 0.12 0.25 0.42 0.62 0.82 0.94 1"
                />
                <feFuncG
                  type="table"
                  tableValues="0.05 0.12 0.25 0.42 0.62 0.82 0.94 1"
                />
                <feFuncB
                  type="table"
                  tableValues="0.05 0.12 0.25 0.42 0.62 0.82 0.94 1"
                />
              </feComponentTransfer>
              <feComposite in="final" in2="SourceGraphic" operator="in" />
            </filter>
            <filter id="shake" x="-20%" y="-20%" width="140%" height="140%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.15"
                numOctaves="2"
                seed="1"
                result="noise"
              >
                <animate
                  attributeName="seed"
                  values="1;5;2;8;3;7;4;9;6;10"
                  dur="3s"
                  repeatCount="indefinite"
                />
              </feTurbulence>
              <feDisplacementMap
                ref={eDisplaceRef}
                in="SourceGraphic"
                in2="noise"
                scale="800"
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
            <mask id="z-mask-old">
              <polygon
                ref={clipOldRef}
                points="315,380 515,80 790,80 790,380"
                fill="white"
              />
            </mask>
            <mask id="z-mask-new">
              <polygon
                ref={clipNewRef}
                points="515,380 515,80 515,80 315,380"
                fill="white"
              />
            </mask>
            <filter id="a-blur" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur
                ref={aBlurRef}
                in="SourceGraphic"
                stdDeviation="40"
              />
            </filter>
          </defs>
          <g id="Layer_1" data-name="Layer 1">
            <path
              id="fl"
              opacity={0}
              d="M404.7,48.44v320h-76.41V48.44h76.41Z"
            />
            <path
              id="fi"
              opacity={0}
              d="M491.41,100.47c-10.73,0-19.95-3.57-27.66-10.7-7.71-7.13-11.56-15.75-11.56-25.86s3.85-18.57,11.56-25.7c7.71-7.13,16.93-10.7,27.66-10.7s20.08,3.57,27.73,10.7c7.66,7.14,11.48,15.7,11.48,25.7s-3.83,18.73-11.48,25.86c-7.66,7.14-16.9,10.7-27.73,10.7ZM453.13,368.44v-240h76.41v240h-76.41Z"
            />
          </g>
          <g id="a" filter="url(#a-blur)">
            <g
              ref={faScaleRef}
              transform={`translate(988, 372) scale(1.5) translate(-988, -372)`}
            >
              <path
                id="fa"
                opacity={aSwapped ? 1 : 0}
                d="M901.72,372.5c-15.31,0-28.88-2.58-40.7-7.73-11.82-5.16-21.15-12.97-27.97-23.44-6.82-10.47-10.23-23.62-10.23-39.45,0-13.33,2.34-24.58,7.03-33.75,4.69-9.17,11.14-16.61,19.38-22.34,8.23-5.73,17.71-10.08,28.44-13.05,10.73-2.97,22.19-4.97,34.38-6.02,13.64-1.25,24.63-2.58,32.97-3.98,8.33-1.41,14.4-3.44,18.2-6.09,3.8-2.66,5.7-6.43,5.7-11.33v-.78c0-8.02-2.76-14.22-8.28-18.59-5.52-4.38-12.97-6.56-22.34-6.56-10.11,0-18.23,2.19-24.38,6.56-6.15,4.38-10.05,10.42-11.72,18.12l-70.47-2.5c2.08-14.58,7.47-27.63,16.17-39.14,8.7-11.51,20.68-20.57,35.94-27.19,15.26-6.61,33.62-9.92,55.08-9.92,15.31,0,29.43,1.8,42.34,5.39,12.92,3.59,24.17,8.8,33.75,15.62,9.58,6.82,17,15.18,22.27,25.08,5.26,9.9,7.89,21.2,7.89,33.91v163.13h-71.88v-33.44h-1.88c-4.27,8.12-9.71,15-16.33,20.62-6.62,5.62-14.38,9.84-23.28,12.66s-18.93,4.22-30.08,4.22ZM925.31,322.5c8.23,0,15.65-1.67,22.27-5,6.61-3.33,11.9-7.94,15.86-13.83,3.96-5.88,5.94-12.73,5.94-20.55v-22.81c-2.19,1.15-4.82,2.19-7.89,3.12-3.07.94-6.43,1.82-10.08,2.66-3.65.83-7.4,1.56-11.25,2.19-3.86.62-7.55,1.2-11.09,1.72-7.19,1.15-13.31,2.92-18.36,5.31-5.05,2.4-8.91,5.5-11.56,9.3-2.66,3.8-3.98,8.31-3.98,13.52,0,7.92,2.84,13.96,8.52,18.12,5.68,4.17,12.89,6.25,21.64,6.25Z"
              />
            </g>
            <path
              id="a2"
              className="letter-a-shadow"
              opacity={aSwapped ? 0 : 1}
              d="M950.11,211.23c20.98-18.02,8.08-66.44-11.06-82.22-11.75-9.68-29.7-12.45-44.23-8.81-30.34,7.61-32.68,38.61-53.96,56.92-39.8,34.23-99.25-2.7-80.34-56.97,24.03-68.98,132.37-89.06,190.33-55.04,55.75,32.72,37.66,129.19-9.86,160.7-22.83,15.14-57.95,18.86-75.4,40.16-10.9,13.3-7.6,27.36,8.67,33.37,29.91,11.04,60.9-25.99,74.68-48.21,8.9-14.37,27.64-55.9,45.88-57.65s17.82,18.5,17.03,31.05c-1.55,24.53-16.69,61.28,3.02,81.16,12.67,12.79,38.74,14.99,36.21,38.23-2.96,27.18-47.97,27.37-60.89,7.82-19.15-28.97,3.82-93.56,9.33-126.18,1.23-7.29,5.37-23.5-6.09-24.02-11.63-.53-21.37,22.83-24.83,31.85-12.79,33.3-18.9,64.46-42.27,93.33-32.07,39.61-93.86,52.61-138.93,28.09-30.49-16.6-46.01-46.29-37.48-80.92,18.29-74.21,127.6-51.25,182.09-55.7,6.34-.52,13.26-2.8,18.09-6.95Z"
            />
            <path
              id="a1"
              className="letter-a"
              opacity={aSwapped ? 0 : 1}
              d="M940.11,201.23c20.98-18.02,8.08-66.44-11.06-82.22-11.75-9.68-29.7-12.45-44.23-8.81-30.34,7.61-32.68,38.61-53.96,56.92-39.8,34.23-99.25-2.7-80.34-56.97,24.03-68.98,132.37-89.06,190.33-55.04,55.75,32.72,37.66,129.19-9.86,160.7-22.83,15.14-57.95,18.86-75.4,40.16-10.9,13.3-7.6,27.36,8.67,33.37,29.91,11.04,60.9-25.99,74.68-48.21,8.9-14.37,27.64-55.9,45.88-57.65s17.82,18.5,17.03,31.05c-1.55,24.53-16.69,61.28,3.02,81.16,12.67,12.79,38.74,14.99,36.21,38.23-2.96,27.18-47.97,27.37-60.89,7.82-19.15-28.97,3.82-93.56,9.33-126.18,1.23-7.29,5.37-23.5-6.09-24.02-11.63-.53-21.37,22.83-24.83,31.85-12.79,33.3-18.9,64.46-42.27,93.33-32.07,39.61-93.86,52.61-138.93,28.09-30.49-16.6-46.01-46.29-37.48-80.92,18.29-74.21,127.6-51.25,182.09-55.7,6.34-.52,13.26-2.8,18.09-6.95Z"
            />
          </g>
          <g mask="url(#z-mask-old)">
            <g id="z">
              <polygon
                id="z5"
                fill="url(#z-grad)"
                className={`z-piece-lr${measured ? " reveal" : ""}`}
                style={{ animationDelay: "150ms" }}
                points="726.76 348.72 551.58 348.72 551.58 348.71 521.57 318.71 696.76 318.71 726.76 348.72"
              />
              <polygon
                id="z4"
                fill="url(#z-grad2)"
                className={`z-piece-trbl${measured ? " reveal" : ""}`}
                style={{ animationDelay: "200ms" }}
                points="734.63 304.14 732.05 318.71 726.76 348.72 696.76 318.71 696.75 318.71 696.75 318.7 704.62 274.13 734.63 304.14"
              />
              <polygon
                id="z3"
                fill="url(#z-grad2)"
                className={`z-piece-trbl${measured ? " reveal" : ""}`}
                style={{ animationDelay: "50ms" }}
                points="776.35 117.24 763.54 134.24 741.78 163.11 678.1 247.61 658.14 274.12 607.79 274.12 649.4 218.91 691.45 163.11 713.21 134.24 747.65 88.54 776.35 117.24"
              />
              <polygon
                id="z2"
                fill="url(#z-grad)"
                className={`z-piece-lr${measured ? " reveal" : ""}`}
                style={{ animationDelay: "100ms" }}
                points="660.57 134.24 638.83 163.11 593.6 163.11 564.73 134.24 660.57 134.24"
              />
              <polygon
                id="z1"
                className={`letter-z-fill${measured ? " reveal" : ""}`}
                points="649.4 218.91 607.79 274.12 704.61 274.12 704.62 274.13 696.75 318.7 696.75 318.71 521.57 318.71 555.17 274.12 619.39 188.9 638.83 163.11 660.57 134.24 564.73 134.24 572.79 88.52 747.63 88.52 747.65 88.54 713.21 134.24 691.45 163.11 649.4 218.91"
              />
            </g>
          </g>
          <g mask="url(#z-mask-new)">
            <path
              id="fz"
              d="M578.59,368.44v-43.59l111.25-135.47v-1.56h-107.34v-59.38h198.44v47.81l-103.12,131.25v1.56h106.88v59.38h-206.09Z"
            />
          </g>
          <g filter="url(#shake)">
            <path
              id="e"
              className="letter-e"
              opacity={eSwapped ? 0 : 1}
              d="M275.66,64.16v2.39c2.42-.64,3.74.57,5.64,1.1.38.11,1.22-.56,1.42-.43.18.1,2.01,3.08,2.17,3.48.3.78,2.6,8.82,2.64,9.3.25,3.6-2.98,9.5-.83,12.68,1.66,2.45,1.11.45,2.19,4.35,2.6,9.4,1.87,22.27,2.26,32.22.67,17.01,2.72,31.1,1.75,48.77-.32,5.93-2.09,12.47-2.4,17.82-.44,7.55,1.73,18.7,1.86,26.76.03,2.2-.68,4.08-.64,6.24-6.36.46-12.37-2-18.7-2.4-6.35-.4-15.07-.34-21.45,0-2.81.15-13.52,2.31-15.14,1.51-3.94-1.95,2.7-6.28,3.87-8.62,4.63-9.27,2.77-24.02-1.25-33.25-1.66-3.81-5.74-7.06-9.21-9.22-8.73-5.42-25.57-8.59-35.86-11.11-9.37-2.29-15.86-7.25-24.16.93-2.94,2.9-6.3,11.64-6.41,15.66-.04,1.32.88,1.82.89,2.2,0,.19-1.49,2.26-1.78,3.37-.8,3.08-2.59,11.67-2.23,14.48.16,1.22,1.25,2.35,1.17,2.86-.13.81-4.04,5.24-4.56,6.14-1.06,1.85-1.53,4.24-1.36,6.36l42.56,8.67c2.03,1.99-.55,14.27-.91,17.56-.57,5.27-.91,10.64-1.31,15.94-1.16,2.52-4.08,1.27-6.1,2.72-12.83-1.21-24.64-2.6-37.48-2.26-3.67.09-6.39-1.75-9.97,1.12-2.34,1.88-4.9,7.75-5.53,10.68-1.55,7.18-1.72,16.51-1.75,23.82.84,1.77,6.37,2.38,8.32,2.43,15.26.39,35.75-1.97,51.14-3.61,13.18-1.41,16.25-.75,26.38-10.51,6.23-6.01,12.24-19.48,13.04-28.03.16-1.67-.45-1.99-1.11-3.4l.63-1.16c1.16-.33,2.24-1.06,3.4-1.35,13.87-3.52,40.74-8.87,54.4-6.54,1.98.34,3.84,1.23,5.8,1.64-2.58,3.09-.98,5.26-1.15,8.63-.59,11.44-2.63,21.8-3.01,33.27-.54,16.05-3.09,32.55-2.4,48.78.19,4.51,1.41,8.99,1.24,13.68-.09,2.43-1.58,15.18-2.68,16.34-1.52,1.59-2.96-.3-4.16-.34-10.4-.33-20.68.43-30.95,1.5-2.41.25-5.3-.38-7.59.13-1.38.31-2.78,2.08-3.8,2.18-.9.08-1.48-1.18-2.44-1.55-5.22-2-10.95-2.6-16.49-3.13-19.14-1.84-38.47-1.79-57.69-2.36-35.25-1.04-69.34-2.02-104.55.63-1.57.12-3.23,1.1-4.85,1.15-7.13.2-2.6-8.22-1.73-12.49,2.75-13.5,3.83-25.44,5.7-38.89.34-2.45,1.93-12.82,2.86-14.23s8.36-2.15,10.42-2.21c5.9-.16,10.96,3.24,16.73,1.27,1.21-.97.57-2.84,1.15-4.2s1.75-2.22,2.37-4.17c1.54-4.81-.05-7.37.34-11.54.56-6.01,3.69-11.8,4.11-19.09,1.72-30,7.77-59.61,11.37-89.7.67-5.57,2.42-7.43,1.06-13.69-1.52-6.99-6.06-9.78-12.69-11.68s-12.16-.61-18.79-.84c-.77-.46.14-1.86-.07-2.82-.36-1.7-1.64-3.21-1.72-4.93-.11-2.41,1.43-3.96,1.79-5.97.43-2.45.82-14.4,2.81-15.05.77-.25,2.14.31,2.65-.42,2.57-11.68,5.95-23.07,8.52-34.76.26-1.2,1.27-2.44,1.39-3.37.25-1.87-2.24-5.76-.49-7.02l2.12-.24c.05-2.56,1.59-5.33,1.92-7.62.47-3.23-1.62-14.46,2.8-14.76,1.54-.11,7.23,1.73,9.6,2.05,8.05,1.07,16.17,1.54,24.13,3.21,6.18,1.3,12.95,3.96,19.34,5.03,19.53,3.28,39.61,2.21,59.21,4.99,12.76,1.81,22.21,5.97,35.75,4.67,4.34-.42,9.92-2.33,14.27-2.41,3.81-.08,8.18,1.27,12.2.63Z"
            />
          </g>
          <path
            id="fe"
            opacity={eSwapped ? 1 : 0}
            d="M56.73,368.44V48.44h223.12v62.81h-145.78v65.62h134.38v62.97h-134.38v65.78h145.78v62.81H56.73Z"
          />
          <AnimatedG
            style={{
              transform: lScaleSpring.scale.to((s: number) => `scale(${s})`),
              transformOrigin: "340px 200px",
            }}
          >
            <path
              id="l"
              className={`letter-l${measured ? " draw" : ""}`}
              pathLength="1"
              style={{ opacity: lSwapped ? 0 : undefined }}
              d="M290.35,315.81c27.47-21.72,45.29-44.04,66.03-72.68,60.4-83.43,65.01-186.31,31.58-183.76-73.55,5.63-70.92,280.1-27.12,294.25,29.06,9.39,44.37-33.37,49.45-54.25"
            />
            <path
              id="fl"
              opacity={lSwapped ? 1 : 0}
              d="M404.7,48.44v320h-76.41V48.44h76.41Z"
            />
          </AnimatedG>
          <AnimatedG
            style={{
              transform: to(
                [iSquashSpring.scaleX, iSquashSpring.scaleY],
                (sx: number, sy: number) => `scaleX(${sx}) scaleY(${sy})`,
              ),
              transformOrigin: "494px 200px",
            }}
          >
            <g
              id="i"
              filter="url(#chrome)"
              fill="#999"
              opacity={iSwapped ? 0 : 1}
            >
              <AnimatedG
                style={{
                  transform: i1Spring.scale.to((s: number) => `scale(${s})`),
                  transformOrigin: "494px 85px",
                }}
              >
                <path
                  id="i1"
                  d="M555.53,82.86c3.06,28.78-20.34,56.02-61.7,56.02s-61.97-23.68-61.97-54.12,29.66-56.47,64.53-54.31c37.95,2.35,55.95,22.3,59.14,52.41Z"
                />
              </AnimatedG>
              <AnimatedG
                style={{
                  transform: i2Spring.scale.to((s: number) => `scale(${s})`),
                  transformOrigin: "494px 260px",
                }}
              >
                <path
                  id="i2"
                  d="M560.9,260.03c.05,59.49-17.77,104.02-66.88,104.97-60.71,1.17-65.79-47.05-68.09-104.99-2.66-67.24,23.62-105.01,68.09-105.01,50.52,0,66.83,48.11,66.88,105.04Z"
                />
              </AnimatedG>
            </g>
            <path
              id="fi"
              opacity={iSwapped ? 1 : 0}
              d="M491.41,100.47c-10.73,0-19.95-3.57-27.66-10.7-7.71-7.13-11.56-15.75-11.56-25.86s3.85-18.57,11.56-25.7c7.71-7.13,16.93-10.7,27.66-10.7s20.08,3.57,27.73,10.7c7.66,7.14,11.48,15.7,11.48,25.7s-3.83,18.73-11.48,25.86c-7.66,7.14-16.9,10.7-27.73,10.7ZM453.13,368.44v-240h76.41v240h-76.41Z"
            />
          </AnimatedG>
        </AnimatedSvg>
      </AnimatedDiv>
    </div>
  );
}
