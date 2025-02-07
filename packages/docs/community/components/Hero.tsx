import React from "react";

export default function Hero({
    contributor,
    secondaryText,
    profilePictureSize,
}) {
    return (
        <div
            style={{
                display: "flex",
                gap: "10px",
                alignItems: "center",
            }}
        >
            <img
                src={contributor.avatar_url}
                alt={`${contributor.login}'s avatar`}
                style={{
                    width: profilePictureSize,
                    height: profilePictureSize,
                    borderRadius: "50%",
                }}
            />
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                }}
            >
                <div style={{ fontWeight: "bold", fontSize: "1.2rem" }}>
                    {contributor.login}
                </div>
                {
                    <div
                        style={{
                            color: secondaryText,
                        }}
                    >
                        {contributor.contributions} contributions
                    </div>
                }
            </div>
        </div>
    );
}
