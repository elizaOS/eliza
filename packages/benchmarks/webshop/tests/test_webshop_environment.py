from __future__ import annotations

import asyncio

from elizaos_webshop.dataset import WebShopDataset
from elizaos_webshop.eliza_agent import MockWebShopAgent
from elizaos_webshop.environment import WebShopEnvironment


def test_target_product_requires_goal_options_for_perfect_reward() -> None:
    dataset = WebShopDataset()
    products = {p.product_id: p for p in dataset.create_sample_products()}
    task = dataset.create_sample_tasks()[1]
    env = WebShopEnvironment(products=products)

    env.reset(task)
    env.step("search[insulated leak-proof water bottle]")
    env.step("click[P004]")
    env.step("select_option[size, 500ml]")
    env.step("select_option[color, silver]")
    wrong = env.step("buy")

    assert wrong.done is True
    assert wrong.reward < 1.0

    env.reset(task)
    env.step("search[insulated leak-proof water bottle]")
    env.step("click[P004]")
    env.step("select_option[size, 750ml]")
    env.step("select_option[color, silver]")
    correct = env.step("buy")

    assert correct.done is True
    assert correct.reward == 1.0


def test_mock_agent_uses_goal_options() -> None:
    dataset = WebShopDataset()
    products = {p.product_id: p for p in dataset.create_sample_products()}
    task = dataset.create_sample_tasks()[2]
    env = WebShopEnvironment(products=products)
    agent = MockWebShopAgent(env)

    steps, _final, _obs = asyncio.run(agent.process_task(task))

    actions = [step.action for step in steps]
    assert "select_option[type, decaf]" in actions
    assert env.final_reward == 1.0
