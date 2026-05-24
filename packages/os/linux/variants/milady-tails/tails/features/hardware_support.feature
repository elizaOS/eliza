@product
Feature: Hardware support
  In order to understand why Tails does not work
  As someone using a computer that is not supported by Tails
  I want to be informed that my hardware is not supported

  @broken_welcome_screen
  Scenario: Alerting about unsupported graphics card before reaching the Welcome Screen
    Given a computer
    And the computer has an unsupported graphics card
    When I start the computer
    Then the computer boots Tails
    Then I see a graphics card failure message on the splash screen
