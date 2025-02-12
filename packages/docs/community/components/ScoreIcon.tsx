import React from "react";

export default function ScoreIcon({ style, iconColor, iconSize, score }) {
    function Flash({ size, fill }) {
        return (
            <svg
                fill={fill}
                height={size}
                width={size}
                viewBox="0 0 32 32"
                xmlns="http://www.w3.org/2000/svg"
            >
                <path d="M16.74 14.284L19.51 4 8 18.27h6.262l-3.502 9.317 12.666-13.303H16.74zM16 32C7.163 32 0 24.837 0 16S7.163 0 16 0s16 7.163 16 16-7.163 16-16 16z" />
            </svg>
        );
    }

    return (
        <div
            style={{
                borderRadius: "999px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-evenly",
                ...style,
            }}
        >
            <Flash size={iconSize} fill={iconColor} />
            <div>{typeof score === "number" ? score : "NULL"}</div>
        </div>
    );
}
