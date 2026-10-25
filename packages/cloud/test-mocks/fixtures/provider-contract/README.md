# Provider contract fixtures

Fixture data in this directory must be deterministic, synthetic, and safe to
commit. Never record provider credentials, production identifiers, personal
data, or raw upstream captures.

Each adapter suite declares its scenarios in
`provider-contract-inventory.json`. Construct `ProviderProtocolFixture` values
with stable IDs, explicit methods and paths, concrete status codes, and the
smallest response body that proves the protocol behavior. Queue transport
faults in the test rather than encoding timing or process state in JSON.

The normal CI lane uses `startFakeProvider()` over loopback HTTP and must need
neither internet access nor secrets. A provider sandbox or live lane may add
evidence, but `liveLaneRequiredInForks` must remain `false`.
