import React, { useState, useRef, useEffect } from "react";
import type { GitHubItem } from "./Contributions";
import { GITHUB_PAGE_LIMIT } from "./Contributors";

interface AccordionProps {
    title: string;
    isOpen: boolean;
    onToggle: () => void;
    data: GitHubItem[];
    loadMore?: () => void;
    total_count: number;
    primaryText?: string;
    secondaryText?: string;
    mainBackgroundColor?: string;
}

export const Accordion: React.FC<AccordionProps> = ({
    title,
    isOpen,
    onToggle,
    data,
    loadMore,
    total_count,
    primaryText,
    secondaryText,
    mainBackgroundColor,
}) => {
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    const [hoverLoadMore, setHoverLoadMore] = useState<boolean>(false);
    const [maxHeight, setMaxHeight] = useState<string>(
        isOpen ? "1000px" : "0px",
    );

    const contentRef = useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        setMaxHeight(isOpen ? "1000px" : "0px");
    }, [isOpen]);

    useEffect(() => {
        if (contentRef.current && data.length > GITHUB_PAGE_LIMIT) {
            contentRef.current.scrollTo({
                top: contentRef.current.scrollHeight,
                behavior: "smooth",
            });
        }
    }, [data]);

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                borderRadius: "0.5rem",
                padding: "1rem",
                color: primaryText ?? "black",
                background: mainBackgroundColor ?? "",
            }}
        >
            <div
                onClick={onToggle}
                style={{
                    cursor: "pointer",
                    fontWeight: "bold",
                    fontSize: "1rem",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                }}
            >
                <div>{title}</div>
                <div
                    style={{
                        transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                        transition: "transform 0.3s ease",
                    }}
                >
                    {"▶"}
                </div>
            </div>
            <div
                ref={contentRef}
                style={{
                    maxHeight,
                    overflow: "scroll",
                    transition: isOpen ? "max-height 1s ease" : "",
                    scrollbarWidth: "none",
                    msOverflowStyle: "none",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "1rem",
                        margin: "2rem 0 1rem 1rem",
                    }}
                >
                    {data.map((entry, index) => (
                        <div
                            key={index}
                            style={{
                                opacity: hoveredIndex === index ? 0.8 : 1.0,
                            }}
                        >
                            <div
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    marginBottom: "0.5rem",
                                    cursor: "pointer",
                                    transition: "color 0.2s ease",
                                }}
                                onMouseEnter={() => setHoveredIndex(index)}
                                onMouseLeave={() => setHoveredIndex(null)}
                                onClick={() =>
                                    window.open(
                                        entry.html_url,
                                        "_blank",
                                        "noopener,noreferrer",
                                    )
                                }
                            >
                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "0.5rem",
                                    }}
                                >
                                    {entry.bullet && (
                                        <div
                                            style={{
                                                width: "0.5rem",
                                                height: "0.5rem",
                                                borderRadius: "50%",
                                                backgroundColor: entry.bullet,
                                            }}
                                        ></div>
                                    )}
                                    <div>{entry.title}</div>
                                </div>
                                <div
                                    style={{
                                        fontSize: "0.8rem",
                                        color: secondaryText ?? "gray",
                                    }}
                                >
                                    {entry.created_at.split("T")[0]}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
            {isOpen && loadMore && data.length < total_count && (
                <div
                    style={{
                        width: "100%",
                        display: "flex",
                        justifyContent: "center",
                    }}
                >
                    <span
                        style={{
                            color: hoverLoadMore
                                ? (secondaryText ?? "#3b82f6")
                                : (primaryText ?? "black"),
                            cursor: "pointer",
                        }}
                        onMouseEnter={() => setHoverLoadMore(true)}
                        onMouseLeave={() => setHoverLoadMore(false)}
                        onClick={loadMore}
                    >
                        Load more
                    </span>
                </div>
            )}
        </div>
    );
};
