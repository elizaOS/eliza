import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/themes/prism-tomorrow.css";
import "./LandingPage.css";

const ExampleTurnCard: React.FC = () => {
  const [showCode, setShowCode] = React.useState(false);

  const programs = [
    {
      id: "ComputeBudget111111111111111111111111111111",
      label: "Compute Budget",
      ixs: [2, 3],
      expl: "setComputeUnitLimit, setComputeUnitPrice",
    },
    {
      id: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
      label: "Memo",
      ixs: [101],
      expl: "Memo V1 (data payload)",
    },
    {
      id: "11111111111111111111111111111111",
      label: "System Program",
      ixs: [0, 1, 2],
      expl: "transfer, createAccount, assign",
    },
  ];
  const reward = 6;

  useEffect(() => {
    Prism.highlightAll();
  }, [showCode]);

  const tsCode = `import { Transaction, SystemProgram, PublicKey, Keypair, ComputeBudgetProgram } from '@solana/web3.js';

export async function executeSkill(blockhash: string): Promise<string> {
    const tx = new Transaction();
    const agentPubkey = new PublicKey('CiPkkCaoiWPy52azYmUbKKAew8fdvDkrxn7t2mtQX8Ts');
    
    // Create account for operations
    const newAccount = Keypair.generate();
    
    const memoProgram = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

    // Add ComputeBudget instructions
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));

    // Add SystemProgram instructions
    tx.add(SystemProgram.transfer({
        fromPubkey: agentPubkey,
        toPubkey: newAccount.publicKey,
        lamports: 1_000,
    }));

    tx.add(SystemProgram.createAccount({
        fromPubkey: agentPubkey,
        newAccountPubkey: newAccount.publicKey,
        lamports: 1_000_000,
        space: 0,
        programId: memoProgram,
    }));

    tx.add(SystemProgram.assign({
        accountPubkey: newAccount.publicKey,
        programId: memoProgram,
    }));

    // Add Memo program instruction (manual discriminator form)
    tx.add(new TransactionInstruction({
        programId: memoProgram,
        keys: [],
        data: Buffer.from("hello world", "utf-8"),
    }));

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;

    return tx.serialize().toString("base64");
}`;

  return (
    <section>
      <h3 style={{ marginTop: "1.25rem" }}>
        Example Output from Basic Environment
      </h3>
      <div
        className="example-card"
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 16,
          background: "#f8fafc",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              Execution Result
            </div>
            <div style={{ marginTop: 4 }}>
              <span role="img" aria-label="success">
                ✅
              </span>{" "}
              Transaction executed successfully &nbsp;·&nbsp; <b>+{reward}</b>{" "}
              reward points
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <p>
            Agent is prompted to compose a valid tansaction that maximizes it's
            score. It has access to <code>@solana/web3.js</code> and must write
            typescript code that can be executed to produce a base64 serialized
            transaction. That transaction will be executed against{" "}
            <a
              href="https://surfpool.run"
              target="_blank"
              rel="noopener noreferrer"
            >
              Surfpool
            </a>{" "}
            which is a safe sandbox proxy to mainnet. The LLM is rewarded for
            each unique (program_id, instruction_discriminator) pair in a
            successful transaction.
            <br />
            <br />
            In this example an LLM created a succesful transaction that executed
            the following instructions. For this, it was awarded 6 points. You
            can explore the code it wrote below.
          </p>
        </div>

        <div style={{ marginTop: 12 }}>
          <table
            className="trajectory-table"
            style={{ width: "100%", borderCollapse: "collapse" }}
          >
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Program</th>
                <th style={{ textAlign: "left" }}>Program ID</th>
                <th style={{ textAlign: "left" }}>Instruction IDs</th>
                <th style={{ textAlign: "left" }}>Explanation</th>
              </tr>
            </thead>
            <tbody>
              {programs.map((p) => (
                <tr key={p.id}>
                  <td className="model-name">{p.label}</td>
                  <td className="metric-value">
                    <code>{p.id.slice(0, 8)}…</code>
                  </td>
                  <td className="metric-value">{p.ixs.join(", ")}</td>
                  <td className="metric-value">{p.expl}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8, color: "#64748b", fontSize: 14 }}>
            <b>Scoring rule (Basic/Swap):</b> +1 for each first-seen{" "}
            <code>(program_id, instruction_discriminator)</code> pair in a
            successful tx. This turn hit 6 new pairs → <b>6 points</b>.
          </div>
        </div>

        <div
          style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}
        >
          <button className="cta-button" onClick={() => setShowCode((v) => !v)}>
            {showCode ? "Hide Code" : "Show Code"}
          </button>
        </div>

        {showCode && (
          <pre
            style={{
              background: "#0b1020",
              color: "white",
              padding: 12,
              borderRadius: 8,
              overflowX: "auto",
              marginTop: 12,
            }}
          >
            <code className="language-typescript">{tsCode}</code>
          </pre>
        )}
      </div>
    </section>
  );
};

const LandingPage: React.FC = () => {
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  const handleImageClick = (src: string) => {
    setExpandedImage(src);
  };

  const handleCloseModal = () => {
    setExpandedImage(null);
  };

  return (
    <div className="landing-page">
      <div className="hero-section">
        <h1>Solana Bench</h1>
        <p className="subtitle">
          How Well Can LLMs Build Complex Transactions?
        </p>
        <Link to="/trajectories" className="cta-button">
          Explore Trajectories →
        </Link>
      </div>

      <div className="content-section">
        <section>
          <h2>Introducing Solana Bench</h2>
          <p className="intro">
            At the Solana Foundation, we want to fund open-source AI tooling
            that measurably improves how developers and applications use Solana.
            The challenge is measuring the usefulness of these tools. Until now,
            we haven't had a simple, reproducible way to evaluate whether new
            tools actually make it easier for language models to build and run
            transactions on Solana. We've experimented with Q&A benchmarks (too
            costly to maintain), tool-calling benchmarks in agent kits (too
            brittle and fragmented across stacks), and funding one-off toolkits
            (hard to track impact). Each attempt has taught us something, but
            none have given us a sustainable standard. That's why we're
            introducing <b>Solana Bench</b> — two lightweight, open-ended
            environments designed to test LLMs' operational competence on Solana
            in a way that is <b>simple, reproducible, and objective</b>.
            <ol>
              <li>
                <b>Basic</b> - maximize the number of <b>new instructions</b>{" "}
                successfully executed using only foundational SDKs (e.g.
                @solana/web3.js, Anchor, etc)
              </li>
              <li>
                <b>Swap</b> - same success criterion, but within a Defi-leaning
                surface (Jupiter, Orca, Raydium, Phoenix, Meteora) using
                additional example prompts and preinstalled SDKs
              </li>
            </ol>
            These environments are not about measuring profit and loss. They are
            about <b>operational Solana competence</b>. These environments
            reward composing valid transactions, choosing accounts
            appropriately, using SDKs correctly, recovering from errors, and
            exploring breadth across programs. These environments are inspired
            by other open-ended benchmarks like{" "}
            <a
              href="https://www.anthropic.com/news/visible-extended-thinking"
              target="_blank"
              rel="noopener noreferrer"
            >
              ClaudePlaysPokemon
            </a>
            ,{" "}
            <a
              href="https://huggingface.co/blog/textquests"
              target="_blank"
              rel="noopener noreferrer"
            >
              TextQuest
            </a>
            {", "}
            and Nvidia's{" "}
            <a
              href="https://voyager.minedojo.org/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Voyager.
            </a>
          </p>
        </section>

        <section>
          <h2>Why Measurement Has Been Hard</h2>
          <p>
            The Solana Foundation wants to fund exceptional open-source
            development at the frontier of AI and Solana. Over the last 9 months
            , we have sought & funded various efforts to evaluate LLMs on their
            operational Solana knowlege. The following are some of the things we
            have tried, and what we learned.
          </p>

          <h3 style={{ marginBottom: "10px" }}>
            What we tried — and why it wasn't sustainable
          </h3>
          <ul style={{ marginLeft: "15px", marginBottom: "20px" }}>
            <li style={{ marginBottom: "0.5rem" }}>
              <u>Q&amp;A benchmarks:</u> High-quality question-answer datasets
              take significant ongoing curation to stay accurate as programs,
              SDKs, and best practices evolve. Those hours come from the same
              teams building protocol infrastructure, which is a tradeoff we
              can't justify long-term. We're grateful to{" "}
              <a
                href="https://x.com/LumoLabsDotAI"
                target="_blank"
                rel="noopener noreferrer"
              >
                @LumoLabsDotAI
              </a>{" "}
              for assembling sample datasets that helped us visualize strengths
              and gaps, and to articulate the pros/cons more clearly.
            </li>
            <li style={{ marginBottom: "0.5rem" }}>
              <u>Tool-calling benchmarks in agent kits:</u> We funded the
              addition of{" "}
              <a
                href="https://github.com/sendaifun/solana-agent-kit/pull/331"
                target="_blank"
                rel="noopener noreferrer"
              >
                hundreds
              </a>{" "}
              of{" "}
              <a
                href="https://github.com/sendaifun/solana-agent-kit/pull/347"
                target="_blank"
                rel="noopener noreferrer"
              >
                tool-calling benchmarks
              </a>{" "}
              in SendAI's{" "}
              <a
                href="https://github.com/sendaifun/solana-agent-kit"
                target="_blank"
                rel="noopener noreferrer"
              >
                Solana Agent Kit
              </a>
              . The goal was to create a suite of evaluations that could be used
              to test LLM applications for regressions in their Solana
              capability before they went into production.{" "}
              <b>
                We failed at building a tool-calling benchmark useful for
                applications, but succeeded in{" "}
                <a
                  href="https://github.com/sendaifun/solana-agent-kit/pull/345"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  improving
                </a>{" "}
                Solana Agent Kit.
              </b>{" "}
              Tool-calling benchmarks measure complex and confounding behaviors:
              tool selection amongst hundreds of tools, sequential tool-calling
              to achieve complicated tasks, and recovery from failure due to
              implementation errors. Tool-calling benchmarks are useful for
              improving an LLM's usage of a single toolkit, but not for a wider
              ecosystem of applications built on diverse tooling. For example,
              many Solana AI teams use ElizaOS, and are unable to use the Solana
              Agent Kit evals. We would have loved to share results with ElizaOS
              agents, since we found that many ElizaOS agents are so strongly
              guided by their character files that they will fail basic single
              tool call evaluations. But alas, the tool-calling benchmarks were
              specific to Solana Agent Kit.{" "}
            </li>
            <li style={{ marginBottom: "0.5rem" }}>
              <u>Funding more toolkits:</u> Funding more toolkits often means
              funding individual teams, but not necessarily ecosystem-level
              improvements. What we were missing was a <i>simple, open-ended</i>{" "}
              benchmark that any team could run, which would let us measure
              whether our investments are actually moving AI usability forward
              on Solana.
            </li>
          </ul>

          <h3 style={{ marginBottom: "10px" }}>Why these two environments</h3>
          <p>
            The <b>Basic</b> and <b>Swap</b> environments aim to give us
            lightweight, reproducible tests of{" "}
            <b>operational Solana competence</b>. They avoid subjective P&amp;L,
            minimize ongoing maintenance, and reflect the real skills we want
            agents to demonstrate. Skill like composing valid transactions,
            wiring accounts correctly, using SDKs appropriately, recovering from
            errors, and exploring breadth across programs. We see this as a
            practical baseline for the community to iterate on together.
          </p>
        </section>

        <section>
          <h2>Evaluation Protocol</h2>
          <ol>
            <li>
              <u>Budget</u>: 50 messages per model per run
            </li>
            <li>
              <u>Per-turn constraint</u>: Model emits <b>Typescript</b> that
              must produce <b>exactly one unsigned transaction</b> that will be
              signed by the environment
            </li>
            <li>
              <u>Execution</u>: Run against a sandboxed Solana validator (
              <a
                href="https://surfpool.run"
                target="_blank"
                rel="noopener noreferrer"
              >
                Surfpool
              </a>
              ) that mimics mainnet
            </li>
            <li>
              <u>Score</u>: # of unique instructions from successfully executed
              transactions over a single run. Instructions are identified solely
              by the first byte of instruction data.
            </li>
          </ol>
          <ExampleTurnCard />
          <p>
            Scores are unbounded. If an LLM was resourceful enough, it could
            recall all the no-operation programs on Solana, and iterate through
            256 different first bytes of instruction data (and one empty
            instruction), and achieve 257 points per program. Further research
            can consider filtering the reward function to only award points for
            specific programs & instructions.
          </p>
        </section>

        <section>
          <h2>Results</h2>
          <p>
            We evaluated 4 models on each benchmark over 5 runs. We note that
            the cost for this suite of evaluations hovers around $150-200 USD at
            the time of this writing. The primary cost driver is Claude Sonnet
            4, which is roughly 10x more expensive than Gemini 2.5 Flash &
            gpt-oss-120b.
          </p>
          <h3>Basic Benchmark</h3>
          <table className="trajectory-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Median Score</th>
                <th>Max Score</th>
                <th>Min Score</th>
                <th>Median Programs Used</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="model-name">claude-sonnet-4</td>
                <td className="metric-value reward-high">115</td>
                <td className="metric-value">181</td>
                <td className="metric-value">30</td>
                <td className="metric-value">5</td>
              </tr>
              <tr>
                <td className="model-name">gpt-5</td>
                <td className="metric-value reward-med">60</td>
                <td className="metric-value">66</td>
                <td className="metric-value">57</td>
                <td className="metric-value">8</td>
              </tr>
              <tr>
                <td className="model-name">gemini-2.5-flash</td>
                <td className="metric-value reward-low">40</td>
                <td className="metric-value">44</td>
                <td className="metric-value">23</td>
                <td className="metric-value">6</td>
              </tr>
              <tr>
                <td className="model-name">gpt-oss-120b</td>
                <td className="metric-value reward-low">23</td>
                <td className="metric-value">25</td>
                <td className="metric-value">16</td>
                <td className="metric-value">6</td>
              </tr>
            </tbody>
          </table>
          <div className="image-gallery">
            <img
              src="/solana-gym-env/assets/basic_individual_trajectories.png"
              alt="Individual Model Trajectories (Basic)"
              onClick={() =>
                handleImageClick(
                  "/solana-gym-env/assets/basic_individual_trajectories.png"
                )
              }
              style={{ cursor: "pointer" }}
            />
          </div>
          <p>
            Claude is definitely the best performer here. Its key insight is
            that the memo programs can be used to score high without actually
            making progress on the requested task of performing swaps on DEXes.
            Beyond other models, Claude has a strong propensity to game any
            metric or task given to it. This is useful to know when dealing with
            complex environments like Solana.
          </p>

          <h3>Swap Benchmark</h3>
          <table className="trajectory-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Median Score</th>
                <th>Max Score</th>
                <th>Min Score</th>
                <th>Median Programs Used</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="model-name">claude-sonnet-4</td>
                <td className="metric-value reward-high">33</td>
                <td className="metric-value">102</td>
                <td className="metric-value">19</td>
                <td className="metric-value">6</td>
              </tr>
              <tr>
                <td className="model-name">gpt-5</td>
                <td className="metric-value reward-med">30</td>
                <td className="metric-value">34</td>
                <td className="metric-value">27</td>
                <td className="metric-value">16</td>
              </tr>
              <tr>
                <td className="model-name">gemini-2.5-flash</td>
                <td className="metric-value reward-low">14</td>
                <td className="metric-value">18</td>
                <td className="metric-value">0</td>
                <td className="metric-value">3</td>
              </tr>
              <tr>
                <td className="model-name">gpt-oss-120b</td>
                <td className="metric-value reward-low">10</td>
                <td className="metric-value">22</td>
                <td className="metric-value">8</td>
                <td className="metric-value">4</td>
              </tr>
            </tbody>
          </table>
          <div className="image-gallery">
            <img
              src="/solana-gym-env/assets/swap_individual_trajectories_raw.png"
              alt="Individual Model Trajectories Raw(Defi)"
              onClick={() =>
                handleImageClick(
                  "/solana-gym-env/assets/swap_individual_trajectories_raw.png"
                )
              }
              style={{ cursor: "pointer" }}
            />
          </div>
          <p>
            Claude outperforms GPT-5 slightly here, only due to one run where it
            achieved 102 rewards. This is good cause for us to investigate
            further - as noted by{" "}
            <a href="https://x.com/oceanicursula">@oceanicursula</a>{" "}
            <a
              href="https://x.com/oceanicursula/status/1956542070539386930"
              target="_blank"
              rel="noopener noreferrer"
            >
              here.
            </a>{" "}
            In this environment, LLMs are prompted to construct swap
            transactions across different DEXes. SDKs to Jupiter, Orca, Meteora,
            Raydium, and Phoenix are provided. But the LLMs end up only using
            the Jupiter SDK to maximize their score.
            <br />
            <br />
            Upon further investigation, we found that Claude had found a
            loophole, and it had reward-hacked the environment by sending memo
            instructions with slightly different instruction data. After
            filtering out the Memo instructions, we got a clearer picture of
            each model's performance.
          </p>
          <h4>Filtered Swap Benchmark Performance</h4>
          <div className="image-gallery">
            <img
              src="/solana-gym-env/assets/swap_individual_trajectories.png"
              alt="Individual Model Trajectories (Defi)"
              onClick={() =>
                handleImageClick(
                  "/solana-gym-env/assets/swap_individual_trajectories.png"
                )
              }
              style={{ cursor: "pointer" }}
            />
          </div>
          <p>
            GPT-5 outperforms Claude when filtering out Memo & Memo v1 program
            instructions! This points to the difficulty in constructing
            effective and non-gameable environments. We encourage the community
            to build more well rounded environments that are not trivial to
            exploit.
            <br />
            <br />
            We also encourage the Defi community to spend a little more time
            writing great documentation & canonical swap examples using their
            SDKs. Language models are trained on public data and examples. The
            next wave of vibe coders are most likely to use whatever DEX their
            LLM knows how to use.
          </p>
        </section>
        <section>
          <h2>Takeaways</h2>
          <h3>For app builders</h3>
          <p>
            We encourage app developers to put SDK examples on their
            documentation sites, or other crawler-accessible places. This will
            not result in an immediate change in LLM usability, but it will
            result improved LLM understanding of your protocol in the next wave
            of model releases. LLM-readiness can be a part of every team's
            developer adoption strategy.
          </p>
          <h3>For Developers</h3>
          <p>
            For teams that really want to go the extra mile, we recommend them
            to host APIs that abstract away the compositional logic for using
            their protocol. This includes instructions for wrapping & unwrapping
            sol, creating ATAs, setting compute budget limits, and doing other
            protocol-specific initialization steps. We notice that LLMs seem to
            really understand Jupiter's API, and are able to use it to perform
            swaps, and are basically unable to use any other DEX SDK natively.
          </p>
        </section>
        <section>
          <h2>Grant Opportunities</h2>
          <p>
            Expand on this research! We're funding open-sourced research on
            high-quality Solana benchmarks. Here are some ideas:
            <ol>
              <li>
                <u>Protocol Environments</u>: create an environment where LLMs
                are only rewarded for interacting with a specific protocol. This
                could be good to understand which Defi protocols LLMs are best
                at using and why?
              </li>
              <li>
                <u>DevEx Environments</u>: create an environment where LLMs only
                have access to IDLs, or IDL-generated methods instead of SDKs.
                This could be used to improve IDL tooling.
              </li>
              <li>
                <u>System Prompts Improvements</u>: LLMs are very sensitive to
                system prompts. We are open to clear improvements to the system
                prompts in each environment, so long as the changes are well
                explained and result in meaningful changes in benchmark
                performance.
              </li>
              <li>
                <u>Evaluating custom models</u>: we welcome evaluations of
                custom Solana models, but request that the evaluation
                methodology be included, with some way for us to reproduce the
                results.
              </li>
            </ol>
            Apply for funding{" "}
            <a
              href="https://share.hsforms.com/1GE1hYdApQGaDiCgaiWMXHA5lohw"
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "underline" }}
            >
              here
            </a>
            .
          </p>
          <h2>Help us help you build the future of AI on Solana</h2>
          <p>
            If you notice things we missed, or have ideas for how to improve the
            benchmarks, please let us know! We are open to funding more open
            source AI development, but need your help to measure impact. Feel
            free to reach out to us at{" "}
            <a href="mailto:ai@solana.org">ai@solana.org</a>
          </p>
        </section>

        <section className="explore-section">
          <h2>Explore the Data</h2>
          <p>
            Dive into the detailed trajectories to see how each model performed,
            what code they generated, and how they discovered new programs over
            time.
          </p>
          <Link
            to="/trajectories"
            className="cta-button"
            style={{ color: "white" }}
          >
            Explore Trajectories →
          </Link>
        </section>
      </div>

      {/* Image Modal */}
      {expandedImage && (
        <div
          className="image-modal-overlay"
          onClick={handleCloseModal}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.9)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            cursor: "pointer",
          }}
        >
          <img
            src={expandedImage}
            alt="Expanded view"
            style={{
              maxWidth: "90vw",
              maxHeight: "90vh",
              objectFit: "contain",
            }}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={handleCloseModal}
            style={{
              position: "absolute",
              top: "20px",
              right: "20px",
              background: "white",
              border: "none",
              borderRadius: "50%",
              width: "40px",
              height: "40px",
              fontSize: "24px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: "bold",
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
};

export default LandingPage;
