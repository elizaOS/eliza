"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Tab {
  value: string;
  label: string;
}

interface AnimatedTabsProps {
  tabs: Tab[];
  value: string;
  onValueChange: (value: string) => void;
  variant?: "default" | "orange";
  fullWidth?: boolean;
}

export function AnimatedTabs({
  tabs,
  value,
  onValueChange,
  variant = "default",
  fullWidth = false,
}: AnimatedTabsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState({
    left: 0,
    width: 0,
    visible: false,
    animate: true,
  });

  const isOrange = variant === "orange";

  // Use refs to store current values for the resize handler to avoid recreating it
  const tabsRef = useRef(tabs);
  const valueRef = useRef(value);

  const updateIndicator = useCallback((shouldAnimate: boolean = true) => {
    const container = containerRef.current;
    if (!container) return;

    const activeIndex = tabsRef.current.findIndex((tab) => tab.value === valueRef.current);
    const buttons = container.querySelectorAll("[data-tab-button]");
    const activeButton = buttons[activeIndex];

    if (activeButton) {
      const containerRect = container.getBoundingClientRect();
      const buttonRect = activeButton.getBoundingClientRect();

      setIndicatorStyle((prev) => ({
        left: buttonRect.left - containerRect.left,
        width: buttonRect.width,
        visible: true,
        animate: shouldAnimate && prev.visible,
      }));
    } else {
      setIndicatorStyle((prev) => ({ ...prev, visible: false }));
    }
  }, []); // Stable - uses refs

  // Keep refs in sync, then update the indicator for new tab/value props.
  useEffect(() => {
    tabsRef.current = tabs;
    valueRef.current = value;
    updateIndicator(true);
  }, [tabs, updateIndicator, value]);

  // Update indicator on resize (without animation) - stable handler
  useEffect(() => {
    const handleResize = () => {
      updateIndicator(false);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [updateIndicator]);

  return (
    <div
      ref={containerRef}
      role="tablist"
      className={`relative ${fullWidth ? "flex w-full" : "inline-flex"} items-center gap-0.5 p-1 rounded-full bg-white/5 border border-white/10`}
    >
      {/* Animated indicator */}
      <div
        className={`absolute top-1 bottom-1 rounded-full ease-out ${isOrange ? "bg-[#FF5800]" : "bg-white"}`}
        style={{
          left: indicatorStyle.left,
          width: indicatorStyle.width,
          opacity: indicatorStyle.visible ? 1 : 0,
          transition: indicatorStyle.animate ? "all 300ms ease-out" : "opacity 300ms ease-out",
        }}
        aria-hidden="true"
      />

      {/* Tab buttons */}
      {tabs.map((tab) => (
        <button
          key={tab.value}
          data-tab-button
          role="tab"
          aria-selected={value === tab.value}
          aria-controls={`tabpanel-${tab.value}`}
          onClick={() => onValueChange(tab.value)}
          className={`relative z-10 px-3 py-1.5 text-sm font-medium rounded-full transition-colors duration-300 ${
            fullWidth ? "flex-1 text-center" : ""
          } ${
            value === tab.value
              ? isOrange
                ? "text-white"
                : "text-black"
              : "text-white/60 hover:text-white hover:bg-white/10"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
