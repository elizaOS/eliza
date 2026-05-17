from behave import given, when, then
from pathlib import Path
from unittest.mock import Mock
from typing import Union

from tps.configuration.binding import Binding, IsActiveException, IsInactiveException
from tps.configuration.feature import Feature
from tps.service import ConfigFile, Service, State


class MockBinding(Mock):
    def __init__(
        self, src: Union[str, Path] = None, dest: Union[str, Path] = None, **kwargs
    ):
        super().__init__(**kwargs)
        self.src = src
        self.dest = dest
        self._is_active = False

    def __str__(self):
        return f"{self.src}\tsource={self.dest}"

    def activate(self):
        self._is_active = True

    def deactivate(self):
        self._is_active = False

    def is_active(self):
        return self._is_active

    def check_is_active(self):
        if not self._is_active:
            raise IsInactiveException()

    def check_is_inactive(self):
        if self._is_active:
            raise IsActiveException()


# A definition of the context we pass between step implementations.
# This is not actually the class that behave passes to the step_impl
# functions, but pretending that it is provides code completion.
class TestContext(object):
    tps_feature: Feature
    # These are set in environment.py *before* functions
    tmpdir: Path
    mount_point: str
    service: Service


@given("an unlocked Persistent Storage with an empty config file")
def step_impl(context: TestContext):
    context.service.config_file = ConfigFile(context.mount_point)
    context.service.config_file.save([])
    context.service.state = State.UNLOCKED
    context.service.connection = Mock()


@given("a feature with bind mounts")
def step_impl(context: TestContext):
    bind_mount_1 = MockBinding(spec=Binding, src="/src1", dest="dest1")  # type: Binding
    bind_mount_2 = MockBinding(spec=Binding, src="/src2", dest="dest2")  # type: Binding

    class FeatureWithBindMount(Feature):
        Id = "FeatureWithBindMount"
        translatable_name = "FeatureWithBindMount"
        Bindings = [bind_mount_1, bind_mount_2]

    context.tps_feature = FeatureWithBindMount(context.service)


@given("a feature with a bind mount")
def step_impl(context: TestContext):
    # We need an actual binding here instead of a mock binding because this
    # step is used in the "Deleting a feature" scenario which tests
    # Feature.Delete which checks binding.HasData after deleting the
    # source directory, so binding.HasData needs to be implemented.
    bind_mount = Binding(
        "src", Path(context.tmpdir, "dest"), tps_mount_point=context.mount_point
    )

    class FeatureWithBindMount(Feature):
        Id = "FeatureWithBindMount"
        translatable_name = "FeatureWithBindMount"
        Bindings = [bind_mount]

    context.tps_feature = FeatureWithBindMount(context.service)
    context.binding = bind_mount


@given("the feature is active")
def step_impl(context: TestContext):
    context.tps_feature._is_active = True


@given("the feature is not active")
def step_impl(context: TestContext):
    context.tps_feature._is_active = False


@given("the feature is enabled in the config file")
def step_impl(context: TestContext):
    context.service.config_file.save([context.tps_feature])


@given("the feature is not enabled in the config file")
def step_impl(context: TestContext):
    context.service.config_file.save([])


@given("the bind mounts are active")
def step_impl(context: TestContext):
    for binding in context.tps_feature.Bindings:
        binding.activate()


@given("the bind mounts are not active")
def step_impl(context: TestContext):
    for binding in context.tps_feature.Bindings:
        binding.deactivate()


@when("the feature is activated")
def step_impl(context: TestContext):
    context.tps_feature.Activate()


@when("the feature is deactivated")
def step_impl(context: TestContext):
    context.tps_feature.Deactivate()


@when("the feature is deleted")
def step_impl(context: TestContext):
    context.tps_feature.Delete()


@then("the feature is active")
def step_impl(context: TestContext):
    assert context.tps_feature.IsActive


@then("the feature is not active")
def step_impl(context: TestContext):
    assert not context.tps_feature.IsActive


@then("the bind mounts are active")
def step_impl(context: TestContext):
    for bind_mount in context.tps_feature.Bindings:
        assert bind_mount.is_active()


@then("the bind mounts are not active")
def step_impl(context: TestContext):
    for bind_mount in context.tps_feature.Bindings:
        assert not bind_mount.is_active()
