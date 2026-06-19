@product
Feature: Tails-related cryptographic keys are up-to-date

  @doc
  Scenario: The included OpenPGP keys are up-to-date
    Given I have started Tails from DVD without network and logged in
    Then the included OpenPGP keys are valid for the next 1 month

  Scenario: The included APT repository keys are up-to-date
    Given I have started Tails from DVD without network and logged in
    Then the keys trusted by APT are valid for the next 3 months
