/**
 * Footer component for the landing page.
 * Displays navigation links, social links, and branding with decorative background image.
 */

"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { Copy, Check } from "lucide-react";

const TOKEN_ADDRESSES = [
  {
    name: "Solana",
    address: "DuMbhu7mvQvqQHGcnikDgb4XegXJRyhUBfdU22uELiZA",
    id: "solana",
  },
  {
    name: "Ethereum",
    address: "0xea17Df5Cf6D172224892B5477A16ACb111182478",
    id: "ethereum",
  },
  {
    name: "Base",
    address: "0xea17Df5Cf6D172224892B5477A16ACb111182478",
    id: "base",
  },
  {
    name: "Bsc",
    address: "0xea17Df5Cf6D172224892B5477A16ACb111182478",
    id: "bsc",
  },
] as const;

export default function Footer() {
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [showTokens, setShowTokens] = useState(false);
  const tokensRef = useRef<HTMLDivElement>(null);

  const handleCopyAddress = async (address: string, network: string) => {
    await navigator.clipboard.writeText(address);
    setCopiedAddress(network);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  // Handle click outside to close token display
  useEffect(() => {
    if (!showTokens) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        tokensRef.current &&
        !tokensRef.current.contains(event.target as Node)
      ) {
        setShowTokens(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showTokens]);

  // Handle escape key to close token display
  useEffect(() => {
    if (!showTokens) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowTokens(false);
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [showTokens]);

  // Focus management - move focus to container when opened
  useEffect(() => {
    if (showTokens && tokensRef.current) {
      tokensRef.current.focus();
    }
  }, [showTokens]);
  return (
    <footer
      className="relative border-t border-neutral-800 bg-black"
      style={{ flexShrink: 0 }}
    >
      <div className="container mx-auto px-6 py-8 md:py-16 relative z-10">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-8 items-start">
          {/* 1. Left section (Text/Copyright) */}
          <div className="flex flex-col gap-8">
            <div className="flex items-center gap-3 relative mr-auto">
              <svg
                id="poweredby"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 138 54"
                className="w-24 sm:w-32 shrink-0"
              >
                <path
                  className="fill-white"
                  d="M137.7,2.1c0,0,0-.2-.1-.3-.2-.3-.4-.6-.6-.8-.6-.6-1.5-1-2.5-1H3.5C2.5,0,1.7.4,1,1c-.2.2-.4.5-.6.8C.1,2.3,0,2.9,0,3.5v47c0,1.9,1.6,3.5,3.5,3.5h131c1.9,0,3.5-1.6,3.5-3.5V3.5c0-.5,0-1-.3-1.4ZM137.2,50.5c0,1.5-1.2,2.7-2.7,2.7H3.5c-1.5,0-2.7-1.2-2.7-2.7V17.9h136.4v32.6Z"
                />
                <path d="M10.8,10.6h-1.2v2.6c0,.2-.2.4-.4.4h-.8c-.2,0-.4-.2-.4-.4V4.6c0-.2.2-.4.4-.4h2.4c.6,0,1.2.2,1.6.7.4.4.7,1,.7,1.6v1.8c0,.6-.2,1.2-.7,1.6s-1,.7-1.6.7h0ZM11.5,8.4v-2c0-.4-.3-.6-.7-.6h-1.2v3.2h1.2c.4,0,.7-.3.7-.6h0ZM19.4,6.7v4.4c0,.7-.3,1.3-.8,1.9-.5.5-1.2.8-2,.8s-1.4-.3-2-.8-.8-1.1-.8-1.9v-4.4c0-.7.3-1.3.8-1.8.5-.5,1.2-.8,2-.8s1.5.3,2,.8c.5.5.8,1.1.8,1.8h0ZM17.8,11.2v-4.6c0-.6-.5-1-1.2-1s-1.2.5-1.2,1v4.6c0,.6.5,1.1,1.2,1.1s1.2-.5,1.2-1h0ZM23.8,8.8l.5,3.2h.2l.2-3.8v-3.5c0-.2.2-.4.4-.4h.7c.2,0,.4.2.4.4v3.4c0,.1,0,.3,0,.6l-.4,4.7c0,.2-.2.4-.5.4h-1.3c-.2,0-.4-.1-.5-.4l-.5-3.4h-.2l-.5,3.4c0,.2-.2.4-.5.4h-1.3c-.2,0-.4-.1-.5-.4l-.4-4.7c0-.3,0-.5,0-.6v-3.4c0-.2.2-.4.4-.4h.7c.2,0,.4.2.4.4v3.5l.2,3.8h.2l.5-3.2c0-.3.2-.4.4-.4h.9c.2,0,.4.1.4.4ZM31.6,13.6h-4.3c-.2,0-.4-.2-.4-.4V4.6c0-.2.2-.4.4-.4h4.2c.2,0,.4.2.4.4v.8c0,.2-.2.4-.4.4h-3v2.2h2.7c.2,0,.4.2.4.4v.8c0,.2-.2.4-.4.4h-2.7v2.6h3.1c.2,0,.4.2.4.4v.8c0,.2-.2.4-.4.4h0ZM36.5,8.2v-1.8c0-.3-.3-.6-.7-.6h-1.2v3.1h1.2c.4,0,.7-.3.7-.6ZM37.1,10.1l1.3,3.1c0,0,0,.1,0,.2,0,.2-.1.3-.4.3h-.8c-.3,0-.5-.1-.6-.4l-1.1-2.8h-.9v2.8c0,.2-.2.4-.4.4h-.8c-.2,0-.4-.2-.4-.4V4.6c0-.2.2-.4.4-.4h2.4c.6,0,1.2.2,1.6.7.4.4.7,1,.7,1.6v1.7c0,.8-.4,1.5-1,1.9ZM44.2,13.6h-4.3c-.2,0-.4-.2-.4-.4V4.6c0-.2.2-.4.4-.4h4.2c.2,0,.4.2.4.4v.8c0,.2-.2.4-.4.4h-3v2.2h2.7c.2,0,.4.2.4.4v.8c0,.2-.2.4-.4.4h-2.7v2.6h3.1c.2,0,.4.2.4.4v.8c0,.2-.2.4-.4.4h0ZM48.3,13.6h-2.3c-.2,0-.4-.2-.4-.4V4.6c0-.2.2-.4.4-.4h2.3c.7,0,1.3.3,1.8.8s.8,1.1.8,1.9v4.2c0,.7-.3,1.3-.8,1.9-.5.5-1.1.8-1.8.8h0ZM49.2,11.1v-4.3c0-.6-.4-1-1-1h-1v6.3h1c.5,0,1-.4,1-1ZM61,5.8h-1.1v2.1h1.1c.4,0,.7-.3.7-.7v-.8c0-.4-.3-.7-.7-.7h0ZM61,9.5h-1v2.6h1c.4,0,.8-.4.8-.8v-1c0-.3-.3-.8-.8-.8h0ZM58.7,4.2h2.3c.7,0,1.2.2,1.7.6.4.4.7.9.7,1.6v.8c0,.5-.3,1.1-.5,1.3l-.2.2s.1,0,.2.2c0,0,.2.2.3.5.1.3.2.6.2.9v1c0,.7-.2,1.2-.7,1.7-.5.4-1.1.7-1.7.7h-2.2c-.2,0-.4-.2-.4-.4V4.6c0-.2.2-.4.4-.4h0ZM70.1,4.7l-2.2,4.5v4c0,.2-.2.4-.4.4h-.8c-.2,0-.4-.2-.4-.4v-4l-2.2-4.5c0-.1,0-.2,0-.2,0-.2.1-.3.3-.3h.9c.3,0,.5.1.6.4l1.2,2.8,1.2-2.8c.1-.3.3-.4.6-.4h.9c.2,0,.3,0,.3.3s0,0,0,.2h0Z" />
                <g id="elizaos" className="fill-white">
                  <path d="M110.4,37.8v-1.3h-2.6v-1.3h-1.3v-6.5s1.3,0,1.3,0h0v-1.3h1.3v-1.3h10.4v1.3h1.3v1.3h1.3v3.9h-3.9v-1.3h-1.3v-1.3h-5.2v1.3h-1.3v1.3h1.3v1.3h7.8v1.3h1.3v1.3h1.3v5.2h-1.3v1.3h-1.3v1.3h-10.4v-1.3h-1.3v-1.3h-1.2v-3.9h3.9v1.3h1.3v1.3h5.2v-1.3h1.3v-1.3c-2.6,0-5.2,0-7.8,0Z" />
                  <path d="M90.8,44.3v-1.3h-1.3v-1.3h-1.3v-1.3h-1.3v-10.4h1.3v-1.3h1.3v-1.3h1.3v-1.3h9.1v1.3h0s1.3,0,1.3,0v1.3h0s1.3,0,1.3,0v1.3h0s1.3,0,1.3,0v10.4h-1.3v1.3h-1.3v1.3h-1.3v1.3h-9.1,0ZM97.4,30h-3.9v1.3h-1.3v1.3h-1.3v5.2h1.3v1.3h1.3v1.3h3.9v-1.3h1.3v-1.3h1.3v-5.2h-1.3v-1.3h0s-1.3,0-1.3,0v-1.3h0Z" />
                  <path d="M8,26.1h14.1v4h-8.9l-.3.4v2.2c0,.1.3.3.4.4h6.8v4h-6.7c-.1.1-.5.4-.5.5v2.2l.4.4h9.1v4h-14.3v-18.2h0Z" />
                  <path d="M80.4,44.3h-5.2l-1.2-3.2-.5-.3h-6.4l-.5.3-1.2,3.2h-4.9l7.2-18.1h0s5.4,0,5.4,0l7.2,18.2ZM70.5,31.7h-.4s-1.8,5-1.8,5l.4.4h3.2l.4-.3s-1.8-5-1.8-5Z" />
                  <polygon points="44.4 44.3 44.4 40.6 44.4 40.5 52.9 30.6 52.9 30.1 44.5 30.1 44.5 26.1 59.6 26.1 59.6 29.9 51 39.7 51 40.3 59.8 40.3 59.8 44.3 44.4 44.3" />
                  <polygon points="23.5 44.3 23.5 26.1 28.4 26.1 28.4 39.9 28.8 40.3 37.4 40.3 37.4 44.3 23.5 44.3" />
                  <rect x="38.4" y="26.1" width="4.9" height="18.2" />
                  <polygon points="126.9 44.3 123 44.3 123 43 124.3 43 124.3 41.7 125.6 41.7 125.6 40.4 126.9 40.4 126.9 44.3" />
                  <polygon points="83 44.3 83 40.4 84.3 40.4 84.3 41.7 85.6 41.7 85.6 43 86.9 43 86.9 44.3 83 44.3" />
                  <path d="M126.9,26.1v3.9h0s-1.2,0-1.2,0c0,0,0,0,0,0v-1.3h-1.3v-1.3h-1.3v-1.3h3.9Z" />
                  <polygon points="86.9 26.1 86.9 27.4 85.6 27.4 85.6 28.7 84.3 28.7 84.3 30 83 30 83 26.1 86.9 26.1" />
                </g>
              </svg>
            </div>
            <p className="text-sm text-white/60 whitespace-nowrap">
              © 2026 Eliza AI · USA
            </p>
          </div>

          <div className="hidden md:flex justify-center">
            <Image
              src="/eliza-footer.png"
              alt="Footer Decorative Image"
              height={160}
              width={160}
              className="w-40 h-auto"
              draggable={false}
            />
          </div>

          {/* 3. Right section (Navigation/Social Icons) */}
          <div className="flex flex-col gap-1 md:gap-2 items-end">
            {/* Navigation */}
            <nav className="flex flex-col gap-1.5 md:gap-2.5 text-right relative">
              {/* Token Addresses Display - shown above Tokens button when toggled */}
              <div ref={tokensRef} className="relative" tabIndex={-1}>
                {showTokens && (
                  <div
                    id="token-addresses-footer"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="token-title-footer"
                    className="bg-[#0A0A0A] border border-white/10 p-4 sm:p-3 mb-2 w-[calc(100vw-1rem)] sm:w-[460px] max-w-[96vw] absolute bottom-full -right-4 sm:right-0 z-10"
                  >
                    <div className="space-y-3">
                      <h3
                        id="token-title-footer"
                        className="text-xl font-mono font-bold text-brand-orange text-start border-b border-white/10 pb-3 sm:px-3"
                      >
                        elizaOS Token Addresses
                      </h3>
                      <div className="space-y-4 sm:space-y-0 font-mono text-sm">
                        {TOKEN_ADDRESSES.map((token) => (
                          <button
                            type="button"
                            key={token.id}
                            onClick={() =>
                              handleCopyAddress(token.address, token.id)
                            }
                            className="group/token flex flex-col w-full gap-1 sm:gap-0 hover:bg-brand-orange/10 sm:p-3"
                          >
                            <div className="flex items-end gap-1">
                              <span className="text-brand-orange font-semibold">
                                {token.name}
                              </span>
                              <div
                                className="transition-opacity p-1 hover:bg-brand-orange/10 rounded sm:hidden cursor-pointer"
                                role="button"
                                tabIndex={0}
                                aria-label={`Copy ${token.name} address`}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleCopyAddress(token.address, token.id);
                                  }
                                }}
                              >
                                {copiedAddress === token.id ? (
                                  <Check className="size-3.5 text-brand-orange" />
                                ) : (
                                  <Copy className="size-3.5 text-white/70" />
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between gap-2 group">
                              <span className="text-white/70 break-all font-mono text-start tracking-tight sm:tracking-normal">
                                {token.address}
                              </span>
                              <div
                                className="hidden sm:block shrink-0 opacity-100 sm:group-hover/token:opacity-100 sm:opacity-0"
                                aria-label={`Copy ${token.name} address`}
                              >
                                {copiedAddress === token.id ? (
                                  <Check className="size-4 text-brand-orange" />
                                ) : (
                                  <Copy className="size-4 text-white/70" />
                                )}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                <button
                  onClick={() => setShowTokens(!showTokens)}
                  aria-expanded={showTokens}
                  aria-controls="token-addresses-footer"
                  aria-label="View token addresses"
                  className="text-base text-white transition-colors hover:text-[#FF5800]"
                >
                  Token
                </button>
              </div>
              <Link
                href="/docs"
                className="text-base text-white transition-colors hover:text-[#FF5800]"
              >
                Docs
              </Link>
              <Link
                href="/blog"
                className="text-base text-white transition-colors hover:text-[#FF5800]"
              >
                Blog
              </Link>
              <a
                href="/privacy-policy"
                className="text-base text-white transition-colors hover:text-[#FF5800]"
              >
                Privacy
              </a>
              <a
                href="/terms-of-service"
                className="text-base text-white transition-colors hover:text-[#FF5800]"
              >
                Terms
              </a>
            </nav>

            {/* Social icons */}
            <div className="mt-8 flex items-center gap-2.5 md:gap-5">
              <a
                href="https://github.com/elizaos"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white transition-colors hover:text-[#FF5800]"
                aria-label="GitHub"
              >
                <svg
                  className="size-6 md:size-7"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    fillRule="evenodd"
                    d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                    clipRule="evenodd"
                  />
                </svg>
              </a>
              <a
                href="https://discord.gg/mPsBnEXJuA"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white transition-colors hover:text-[#FF5800]"
                aria-label="Discord"
              >
                <svg
                  className="size-6 md:size-7"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              </a>
              <a
                href="https://x.com/elizaos"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white transition-colors hover:text-[#FF5800]"
                aria-label="X (Twitter)"
              >
                <svg
                  className="size-6 md:size-7"
                  fill="currentColor"
                  viewBox="0 0 50 50"
                >
                  <path d="M 5.9199219 6 L 20.582031 27.375 L 6.2304688 44 L 9.4101562 44 L 21.986328 29.421875 L 31.986328 44 L 44 44 L 28.681641 21.669922 L 42.199219 6 L 39.029297 6 L 27.275391 19.617188 L 17.933594 6 L 5.9199219 6 z M 9.7167969 8 L 16.880859 8 L 40.203125 42 L 33.039062 42 L 9.7167969 8 z"></path>
                </svg>
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
