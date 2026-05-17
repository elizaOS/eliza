@product @check_tor_leaks
Feature: Various checks for torified software

  Background:
    Given I have started Tails from DVD and logged in and the network is connected

  Scenario: wget(1) should work for HTTPS and go through Tor
    When I wget "https://example.com/" to stdout
    Then the wget command is successful
    And the wget standard output contains "Example Domain"

  Scenario: curl should work for HTTPS and go through Tor
    When I curl "https://example.com/" to stdout
    Then the curl command is successful
    And the curl standard output contains "Example Domain"
