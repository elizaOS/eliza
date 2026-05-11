# 🛒 WebShop

GEM's Implementation of the WebShop environment and search agents for the paper:

**[WebShop: Towards Scalable Real-World Web Interaction with Grounded Language Agents](https://webshop-pnlp.github.io/)**
[Shunyu Yao*](https://ysymyth.github.io/), [Howard Chen*](https://howard50b.github.io/), [John Yang](https://john-b-yang.github.io/), [Karthik Narasimhan](https://www.cs.princeton.edu/~karthikn/)

## 👋 Overview
WebShop is a simulated e-commerce website environment with 1.18 million real-world products and 12,087 crowd-sourced text instructions. In this environment, an agent needs to navigate multiple types of webpages and issue diverse actions to find, customize, and purchase a product given an instruction. WebShop provides several challenges including understanding compositional instructions, query (re-)formulation, dealing with noisy text in webpages, and performing strategic exploration.

## 🚀 Simple Setup
we simplify the setup of Webshop and optimize the CPU memory footprint (see [pr](https://github.com/axon-rl/gem/pull/111)).

```bash
# pwd is gem
pip install gem-llm[webshop]
bash gem/envs/webshop/setup.sh # other dependencies; preprocess data to database for better cpu usage.
```

## 🛠️ Usage

Simply use the environment registration at `gem/envs/__init__.py`. A test example is
```bash
python -m tests.test_env.test_webshop --env_name webshop:test-text_rich
```
A wandb running log is at [wandb log](https://api.wandb.ai/links/axon-rl/a05ztc0y)
