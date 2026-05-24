@product @check_tor_leaks
Feature: Thunderbird email client
  As a Tails user
  I may want to use an email client

  Background:
    Given I have started Tails from DVD and logged in and the network is connected
    And I have not configured an email account yet
    When I start Thunderbird
    Then I am prompted to setup an email account

  Scenario: No add-ons are installed
    Given I cancel setting up an email account
    When I open Thunderbird's Add-ons Manager
    And I open the Extensions tab
    Then I see that no add-ons are enabled in Thunderbird
    And no unexpected connection has leaked from Thunderbird

  Scenario: I can send emails, and receive emails over IMAP
    When I enter my email credentials into the autoconfiguration wizard
    Then the autoconfiguration wizard's choice for the incoming server is secure IMAP
    And the autoconfiguration wizard's choice for the outgoing server is secure SMTP
    When I accept the autoconfiguration wizard's configuration
    And I send an email to myself
    And I fetch my email
    Then I can find the email I sent to myself in my inbox
    And the only connections have been made to my email server
