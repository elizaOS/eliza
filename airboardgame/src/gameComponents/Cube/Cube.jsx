import React from "react";
import { darken } from "color2k";

const Cube = ({ size = 50, color = "#b3b3b3" }) => {
  const colorDarken1 = darken(color, 0.2);
  const colorDarken2 = darken(color, 0.3);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      version="1.1"
      viewBox="0 0 13.229166 13.229167"
      height={size}
      width={size}
    >
      <defs id="defs3017">
        <filter
          height="1.2763327"
          y="-0.13816634"
          width="1.2236242"
          x="-0.11181209"
          id="filter2614"
          style={{ colorInterpolationFilters: "sRGB" }}
        >
          <feGaussianBlur id="feGaussianBlur2616" stdDeviation="0.21944301" />
        </filter>
      </defs>
      <g transform="translate(0,-283.77082)" id="layer1">
        <g
          transform="matrix(1.8603922,0,0,1.8378374,12.807367,313.46089)"
          id="g2975"
        >
          <path
            id="path2147"
            d="m -5.7289811,-12.428939 0.836726,2.9131116 3.8735272,-0.5076856 -1.057384,-3.304119 z"
            style={{
              fill: "#000000",
              filter: "url(#filter2614)",
              opacity: 0.15,
            }}
          />
          <path
            fill={color}
            d="m -5.4483481,-15.749764 0.836726,3.146974 3.74490418,-0.390756 -0.95214698,-3.140417 z"
            id="path2172"
          />
          <path
            id="path2149"
            d="m -5.4483481,-15.749764 0.836726,3.146974 -0.067049,2.6117986 -0.770527,-2.5051766 z"
            fill={colorDarken1}
          />
          <path
            id="path2151"
            d="m -4.6786711,-9.9909914 0.06705,-2.6117986 3.74490418,-0.390756 -0.19995898,2.559471 z"
            fill={colorDarken2}
          />
        </g>
      </g>
    </svg>
  );
};

export default Cube;
