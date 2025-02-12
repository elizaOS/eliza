import type React from "react";
import type { StatCardProps } from "./Contributions";

export const StatCard: React.FC<StatCardProps> = ({ title, value, style }) => {
    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
                backgroundColor: "white",
                borderRadius: "0.5rem",
                padding: "1rem 0 1rem 1.5rem",
                fontWeight: "bold",
                ...style,
            }}
        >
            <div style={{ fontSize: "1rem" }}>{title}</div>
            <div style={{ fontSize: "1.5rem" }}>{value}</div>
        </div>
    );
};
