import type React from "react";
import { useState } from "react";
import type { ContributorProps } from "./Contributors";
import { THEME_COLORS } from "./Contributors";
import { hexToRgb } from "./utils";
import ScoreIcon from "./ScoreIcon";
import Summary from "./Summary";
import Hero from "./Hero";

const ContributorCard: React.FC<ContributorProps> = ({
    contributor,
    onSelect,
    darkMode,
    activitySummary,
    score,
}) => {
    const [isHovered, setIsHovered] = useState(false);

    return (
        <div
            style={{
                position: "relative",
                borderRadius: "0.5rem",
                height: "13.5rem",
                boxShadow: isHovered
                    ? "0 4px 6px rgba(0, 0, 0, 0.1)"
                    : "0 1px 2px rgba(0, 0, 0, 0.05)",
                transition: "box-shadow 0.2s ease-in-out",
                backgroundColor: darkMode
                    ? THEME_COLORS.dark.mainBackgroundColor
                    : THEME_COLORS.light.mainBackgroundColor,
                cursor: isHovered ? "pointer" : "default",
                padding: "24px",
                justifyContent: "center",
                color: darkMode
                    ? THEME_COLORS.dark.primaryText
                    : THEME_COLORS.light.primaryText,
            }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onClick={onSelect}
        >
            <ScoreIcon
                style={{
                    width: "4rem",
                    height: "1.8rem",
                    position: "absolute",
                    backgroundColor: darkMode
                        ? `rgba(${hexToRgb(THEME_COLORS.dark.secondaryText)}, 0.2)`
                        : `rgba(${hexToRgb(THEME_COLORS.light.secondaryText)}, 0.2)`,
                    color: darkMode
                        ? THEME_COLORS.dark.secondaryText
                        : THEME_COLORS.light.secondaryText,
                    fontSize: "0.75rem",
                    padding: "0.2rem",
                    fontWeight: "bold",
                    top: "10px",
                    right: "10px",
                    gap: "0.15rem",
                }}
                iconColor={
                    darkMode
                        ? THEME_COLORS.dark.secondaryText
                        : THEME_COLORS.light.secondaryText
                }
                iconSize="1rem"
                score={score}
            />
            <Hero
                contributor={contributor}
                secondaryText={
                    darkMode
                        ? THEME_COLORS.dark.secondaryText
                        : THEME_COLORS.light.secondaryText
                }
                profilePictureSize="48px"
            />
            <Summary
                summary={activitySummary}
                style={{
                    marginTop: "1rem",
                    color: darkMode
                        ? `rgba(${hexToRgb(THEME_COLORS.dark.primaryText)}, 0.7)`
                        : `rgba(${hexToRgb(THEME_COLORS.light.primaryText)}, 0.7)`,
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontSize: "0.85rem",
                }}
            />
        </div>
    );
};

export default ContributorCard;
