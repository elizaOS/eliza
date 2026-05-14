@product @check_tor_leaks
Feature: Electrum Bitcoin client
  As a Tails user
  I might want to use a Bitcoin client
  And all Internet traffic should flow only through Tor

  Scenario: I am warned if Electrum is not persistent
    Given I have started Tails from DVD without network and logged in
    When I start Electrum through the GNOME menu
    But the "electrum" tps feature is not enabled
    And I see a warning that Electrum is not persistent
