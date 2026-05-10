from types import SimpleNamespace

import pytest

from packages.benchmarks.woobench.evaluator import WooBenchEvaluator
from packages.benchmarks.woobench.types import (
    HiddenContext,
    Persona,
    PersonaArchetype,
    ReadingSystem,
    ResponseNode,
    ResponseTree,
    Scenario,
    ScenarioScoring,
)


class FakePaymentClient:
    def __init__(self):
        self.created_amounts: list[float] = []
        self.created_charges: list[float] = []

    def create_payment_request(self, *, amount_usd, description, metadata):
        self.created_amounts.append(amount_usd)
        return SimpleNamespace(
            id="payreq_test",
            amount_usd=amount_usd,
            status="requested",
            accepted=False,
            payment_url="http://mock.test/checkout/payreq_test",
            transaction_hash=None,
        )

    def pay_payment_request(self, payment_request_id, *, transaction_hash=None):
        assert payment_request_id in {"payreq_test", "charge_test"}
        return SimpleNamespace(
            id=payment_request_id,
            amount_usd=1.0,
            status="paid",
            accepted=True,
            payment_url="http://mock.test/checkout/payreq_test",
            transaction_hash=transaction_hash,
        )

    def get_payment_request(self, payment_request_id):
        assert payment_request_id == "payreq_test"
        return SimpleNamespace(
            id=payment_request_id,
            amount_usd=1.0,
            status="paid",
            accepted=True,
            payment_url="http://mock.test/checkout/payreq_test",
            transaction_hash="woobench_payment_test_1",
        )

    def create_app_charge(
        self,
        *,
        app_id,
        amount_usd,
        description,
        providers,
        callback_channel,
        metadata,
    ):
        assert app_id == "woobench-mock-app"
        assert "oxapay" in providers
        assert callback_channel["source"] == "woobench"
        assert metadata["payment_action"] in {"CREATE_APP_CHARGE", "TEXT_PAYMENT_REQUEST"}
        self.created_charges.append(amount_usd)
        return SimpleNamespace(
            id="charge_test",
            app_id=app_id,
            amount_usd=amount_usd,
            status="requested",
            providers=providers,
            payment_url="http://mock.test/payment/app-charge/woobench-mock-app/charge_test",
            paid_at=None,
        )

    def create_app_charge_checkout(self, *, app_id, charge_id, provider="oxapay"):
        assert app_id == "woobench-mock-app"
        assert charge_id == "charge_test"
        assert provider == "oxapay"
        return SimpleNamespace(
            provider="oxapay",
            url="http://mock.test/checkout/charge_test?provider=oxapay",
            provider_payment_id="charge_test",
            track_id="charge_test",
        )

    def get_app_charge(self, app_id, charge_id):
        assert app_id == "woobench-mock-app"
        assert charge_id == "charge_test"
        return SimpleNamespace(
            id=charge_id,
            app_id=app_id,
            amount_usd=1.0,
            status="confirmed",
            providers=["stripe", "oxapay"],
            payment_url="http://mock.test/payment/app-charge/woobench-mock-app/charge_test",
            paid_at="2026-05-09T00:00:00Z",
        )


def payment_scenario() -> Scenario:
    persona = Persona(
        id="payer",
        name="Payer",
        archetype=PersonaArchetype.TRUE_BELIEVER,
        background="Pays for readings during tests.",
        hidden_context=HiddenContext(
            life_situation="wants a reading",
            key_themes=["payment", "guidance"],
            emotional_state="open",
            specific_details=["will pay one dollar"],
            trigger_words=["payment"],
            resistance_topics=[],
        ),
        engagement_style="terse",
        payment_willingness=1.0,
        patience=3,
        max_payment=2.0,
    )
    return Scenario(
        id="payment_mock_smoke",
        name="Payment mock smoke",
        persona=persona,
        system=ReadingSystem.TAROT,
        opening="Can I get a reading?",
        scoring=ScenarioScoring(max_score=1, categories={"payment": 1}),
        response_tree=ResponseTree(
            entry_node_id="payment",
            nodes=[
                ResponseNode(
                    id="payment",
                    condition="Agent requests payment",
                    positive_response="Payment sent.",
                    negative_response="No thanks.",
                    neutral_response="Maybe.",
                    points_if_positive=1,
                )
            ],
        ),
        max_turns=1,
    )


def payment_check_scenario() -> Scenario:
    scenario = payment_scenario()
    scenario.id = "payment_check_smoke"
    scenario.max_turns = 2
    scenario.response_tree.nodes[0].follow_up_nodes = ["payment_check"]
    scenario.response_tree.nodes.append(
        ResponseNode(
            id="payment_check",
            condition="Agent checks payment before delivering paid content",
            positive_response="Great.",
            negative_response="No.",
            neutral_response="Okay.",
            points_if_positive=1,
        )
    )
    return scenario


@pytest.mark.asyncio
async def test_woobench_collects_text_payment_through_app_charge_mock():
    payment_client = FakePaymentClient()
    evaluator = WooBenchEvaluator(evaluator_mode="heuristic", payment_client=payment_client)

    async def agent(_history):
        return "I can do this reading for $1.00 before we continue."

    result = await evaluator.run_scenario(payment_scenario(), agent)

    assert result.revenue.payment_requested is True
    assert result.revenue.payment_received is True
    assert result.revenue.amount_earned == 1.0
    assert result.revenue.payment_provider == "mock-app-charge:oxapay"
    assert result.revenue.payment_request_id == "charge_test"
    assert result.revenue.payment_status == "confirmed"
    assert result.revenue.payment_url == "http://mock.test/payment/app-charge/woobench-mock-app/charge_test"
    assert result.revenue.payment_checkout_url == "http://mock.test/checkout/charge_test?provider=oxapay"
    assert result.revenue.payment_transaction_hash == "woobench_payment_mock_smoke_1"
    assert result.revenue.payment_action == "TEXT_PAYMENT_REQUEST"
    assert result.revenue.payment_action_source == "text"
    assert payment_client.created_amounts == []
    assert payment_client.created_charges == [1.0]


@pytest.mark.asyncio
async def test_woobench_executes_structured_charge_action():
    payment_client = FakePaymentClient()
    evaluator = WooBenchEvaluator(evaluator_mode="heuristic", payment_client=payment_client)

    async def agent(_history):
        return {
            "text": "I can continue once the $1.00 crypto charge is paid.",
            "actions": ["BENCHMARK_ACTION"],
            "params": {
                "BENCHMARK_ACTION": {
                    "command": "CREATE_APP_CHARGE",
                    "amount_usd": 1,
                    "provider": "oxapay",
                    "description": "WooBench action charge",
                }
            },
        }

    result = await evaluator.run_scenario(payment_scenario(), agent)

    assert result.revenue.payment_requested is True
    assert result.revenue.payment_received is True
    assert result.revenue.amount_earned == 1.0
    assert result.revenue.payment_provider == "mock-app-charge:oxapay"
    assert result.revenue.payment_request_id == "charge_test"
    assert result.revenue.payment_status == "confirmed"
    assert result.revenue.payment_action == "CREATE_APP_CHARGE"
    assert result.revenue.payment_action_source == "action"
    assert result.revenue.payment_checkout_url == "http://mock.test/checkout/charge_test?provider=oxapay"
    assert result.revenue.payment_transaction_hash == "woobench_payment_mock_smoke_1"
    assert payment_client.created_charges == [1.0]


@pytest.mark.asyncio
async def test_woobench_check_action_does_not_create_second_text_charge():
    payment_client = FakePaymentClient()
    evaluator = WooBenchEvaluator(evaluator_mode="heuristic", payment_client=payment_client)

    async def agent(history):
        user_text = "\n".join(
            turn["content"] for turn in history if turn.get("role") == "user"
        ).lower()
        if "payment sent" in user_text:
            return {
                "text": "I am checking whether the $1.00 charge went through before continuing.",
                "actions": ["BENCHMARK_ACTION"],
                "params": {
                    "BENCHMARK_ACTION": {
                        "command": "CHECK_PAYMENT",
                    }
                },
            }
        return {
            "text": "I can continue once the $1.00 crypto charge is paid.",
            "actions": ["BENCHMARK_ACTION"],
            "params": {
                "BENCHMARK_ACTION": {
                    "command": "CREATE_APP_CHARGE",
                    "amount_usd": 1,
                    "provider": "oxapay",
                    "description": "WooBench action charge",
                }
            },
        }

    result = await evaluator.run_scenario(payment_check_scenario(), agent)

    assert result.revenue.payment_requested is True
    assert result.revenue.payment_received is True
    assert result.revenue.amount_earned == 1.0
    assert result.revenue.payment_provider == "mock-app-charge:oxapay"
    assert result.revenue.payment_request_id == "charge_test"
    assert result.revenue.payment_status == "confirmed"
    assert result.revenue.payment_action == "CHECK_PAYMENT"
    assert result.revenue.payment_action_source == "action"
    assert payment_client.created_charges == [1.0]
    assert payment_client.created_amounts == []
