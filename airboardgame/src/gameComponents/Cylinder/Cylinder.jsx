import React from "react";
import { darken } from "color2k";

const Cylinder = ({ size = 50, color = "#b3b3b3" }) => {
  const colorDarken = darken(color, 0.25);

  return (
    <svg
      version="1.1"
      id="fi_758454"
      xmlns="http://www.w3.org/2000/svg"
      height={size}
      width={size}
      viewBox="0 0 377.208 377.208"
    >
      <path
        style={{ fill: colorDarken }}
        d="M188.604,111.804c-85.159,0-154.645-22.988-159.869-52.245h-0.522v261.747
            c0,30.824,71.576,55.902,160.392,55.902s160.392-25.078,160.392-55.902V59.559h-0.522
            C343.249,88.816,273.763,111.804,188.604,111.804z"
      ></path>
      <path
        style={{ fill: color }}
        d="M188.604,111.804c85.159,0,154.645-22.988,159.869-52.245c0.522-1.045,0.522-2.612,0.522-3.657
            C348.996,25.078,277.42,0,188.604,0S28.212,25.078,28.212,55.902c0,1.045,0,2.612,0.522,3.657
            C33.959,88.816,103.445,111.804,188.604,111.804z"
      ></path>
    </svg>
  );
};

export default Cylinder;
