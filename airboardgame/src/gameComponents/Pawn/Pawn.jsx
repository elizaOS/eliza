import React from "react";
import { darken } from "color2k";

import { uid } from "../../utils";

function Pawn({ size = 50, color = "#b3b3b3" }) {
  const ind = uid();
  const realSize = size * 1.1;
  const colorDarken1 = darken(color, 0.2);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      version="1.1"
      xmlnsXlink="http://www.w3.org/1999/xlink"
      viewBox="0 0 37.443 82.718"
      height={realSize}
      width={realSize / 2.25}
    >
      <defs id={`id__${ind}`}>
        <linearGradient id={`prefix__a__${ind}`}>
          <stop offset={0} stopColor={color} />
          <stop offset={1} stopColor={colorDarken1} />
        </linearGradient>
        <linearGradient id="prefix__b">
          <stop offset={0} stopColor="#2e3436" />
          <stop offset={1} stopOpacity={0} stopColor="#2e3436" />
        </linearGradient>
        <radialGradient
          xlinkHref={`#prefix__a__${ind}`}
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(.89625 0 0 1.00955 150.891 -28.515)"
          r={36}
          cy={30.918}
          cx={-119.59}
          id={`prefix__j__${ind}`}
        />
        <radialGradient
          xlinkHref="#prefix__b"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(.5154 0 0 .27324 119.372 6.721)"
          r={24.25}
          cy={55.827}
          cx={-160.19}
          id="prefix__i"
        />
        <radialGradient
          xlinkHref={`#prefix__a__${ind}`}
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(.8789 0 0 1.47938 153.494 -1372.36)"
          r={49.5}
          cy={953.13}
          cx={-122.32}
          id={`prefix__h__${ind}`}
        />
        <filter
          height={1.66}
          width={1.247}
          y={-0.33}
          x={-0.124}
          id={`prefix__g__${ind}`}
        >
          <feGaussianBlur stdDeviation={2.475} />
        </filter>
      </defs>
      <g strokeWidth={1.198}>
        <path
          d="M86 291c0 4.97-10.745 9-24 9s-24-4.03-24-9 10.745-9 24-9 24 4.03 24 9z"
          transform="matrix(.6253 0 0 .6317 -20.047 -110.543)"
          fillOpacity={0.5}
          filter={`url(#prefix__g__${ind})`}
        />
        <path
          d="M58.74 56.96c0 18.31-4.214 28.718-20.778 28.718S17.184 75.27 17.184 57.233s10.023-38.981 20.778-38.981c10.755-.273 20.778 20.67 20.778 38.707z"
          fill={`url(#prefix__h__${ind})`}
          transform="matrix(.8302 0 0 .83868 -12.794 6.302)"
        />
        <path
          d="M38.462 20.131c-4.94 0-9.268 2.158-13 5.588 3.272 3.353 7.664 5.412 12.5 5.412s9.228-2.06 12.5-5.412c-3.232-3.43-7.56-5.588-12-5.588z"
          fill="url(#prefix__i)"
          transform="matrix(.8302 0 0 .83868 -12.794 6.302)"
        />
        <path
          d="M54.315 8.839c0 9.031-7.321 16.353-16.353 16.353-9.032 0-16.353-7.322-16.353-16.353 0-9.032 7.321-16.354 16.353-16.354 9.032 0 16.353 7.322 16.353 16.354z"
          fill={`url(#prefix__j__${ind})`}
          transform="matrix(.8302 0 0 .83868 -12.794 6.302)"
        />
      </g>
    </svg>
  );
}

export default React.memo(Pawn);
