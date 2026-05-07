/**
 * Landing header: logo and "Get started" CTA.
 * Users click Get started to choose their preferred messaging method.
 * Desktop hover shows QR code to continue on phone.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import { ElizaLogo } from "@/components/brand/eliza-logo";
import { Button } from "@/components/ui/button";
import { buildElizaSmsHref } from "@/lib/contact";

const SMS_PREWRITTEN_MESSAGE = "Hello Eliza!";

export function LandingHeader() {
  const [showQR, setShowQR] = useState(false);

  // SMS URI that opens native messaging app with pre-written text
  const smsUri = buildElizaSmsHref(SMS_PREWRITTEN_MESSAGE);

  return (
    <motion.header
      className="fixed top-0 left-0 z-[100] w-full pointer-events-auto pr-4 sm:pr-[20px] bg-black/40 backdrop-blur-md md:bg-transparent md:backdrop-blur-none"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="flex h-16 items-center justify-between w-full pl-4">
        <Link to="/" className="flex items-center gap-3">
          <ElizaLogo className="h-5 sm:h-6 invert shrink-0" />
        </Link>

        {/* Get Started button with QR code hover */}
        <div
          className="relative"
          onMouseEnter={() => setShowQR(true)}
          onMouseLeave={() => setShowQR(false)}
        >
          <Button
            size="sm"
            className="rounded-md bg-[#FF5800] text-white hover:bg-[#FF5800]/90 font-[family-name:var(--font-inter)]"
            asChild
          >
            <Link to="/get-started">Get started</Link>
          </Button>

          {/* QR Code popup on hover (desktop only) */}
          <AnimatePresence>
            {showQR && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.95 }}
                transition={{ duration: 0.2 }}
                className="absolute top-full right-0 mt-2 hidden md:block"
              >
                <div className="bg-white/10 backdrop-blur-2xl rounded-xl p-5 shadow-xl border border-white/20">
                  <div className="text-center mb-3">
                    <p className="text-xs text-white/50 font-medium">
                      On desktop?
                    </p>
                    <p className="text-sm text-white/80 font-medium">
                      Continue on your phone
                    </p>
                  </div>
                  <QRCodeSVG
                    value={smsUri}
                    size={120}
                    level="M"
                    bgColor="transparent"
                    fgColor="#ffffff"
                  />
                </div>
                {/* Arrow pointing up to button */}
                <div className="absolute -top-1 right-5 w-2 h-2 bg-white/10 backdrop-blur-2xl rotate-45 border-l border-t border-white/20" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.header>
  );
}
