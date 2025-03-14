import React from "react";
import clsx from "clsx";
import Heading from "@theme/Heading";
import styles from "./styles.module.css";

const FeatureList = [
    {
        icon: "🤖",
        title: "Multi-Agent Framework",
        description: (
            <>
                Build and deploy <strong>autonomous AI agents</strong> with
                consistent personalities across Discord, Twitter, and Telegram.
                Full support for voice, text, and media interactions.
            </>
        ),
    },
    {
        icon: "🧠",
        title: "Advanced Capabilities",
        description: (
            <>
                Built-in RAG memory system, document processing, media analysis,
                and autonomous trading capabilities. Supports multiple AI models
                including Llama, GPT-4, and Claude.
            </>
        ),
    },
    {
        icon: "🔌",
        title: "Extensible Design",
        description: (
            <>
                Create custom actions, add new platform integrations, and extend
                functionality through a <b>modular plugin system</b>. Full
                TypeScript support.
            </>
        ),
    },
];

function Feature({ icon, title, description }) {
    return (
        <div className={clsx("col")}>
            <div
                className="margin--md"
                style={{
                    height: "100%",
                }}
            >
                <div className="card__body text--left padding--md">
                    <icon className={styles.featureIcon}>{icon}</icon>
                    <Heading
                        as="h3"
                        style={{
                            color: "var(--ifm-heading-color)",
                        }}
                    >
                        {title}
                    </Heading>
                    <p>{description}</p>
                </div>
            </div>
        </div>
    );
}

export default function HomepageFeatures() {
    return (
        <section className={styles.features}>
            <div className="container">
                <div className="row">
                    <div className={styles.featureGrid}>
                        {FeatureList.map((props, idx) => (
                            <Feature key={idx} {...props} />
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}
