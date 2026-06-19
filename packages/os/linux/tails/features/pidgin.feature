#19040
@product @fragile
Feature: Chatting anonymously using Pidgin
  As a Tails user
  when I chat using Pidgin
  I should be able to persist my Pidgin configuration
  And all Internet traffic should flow only through Tor

  Scenario: Make sure Pidgin's D-Bus interface is blocked
    Given I have started Tails from DVD without network and logged in
    When I start "Pidgin Internet Messenger" via GNOME Activities Overview
    Then I see Pidgin's account manager window
    And Pidgin's D-Bus interface is not available

  @check_tor_leaks
  Scenario: Chatting with some friend over XMPP
    Given I have started Tails from DVD and logged in and the network is connected
    When I start "Pidgin Internet Messenger" via GNOME Activities Overview
    Then I see Pidgin's account manager window
    When I create my XMPP account
    And I close Pidgin's account manager window
    Then Pidgin automatically enables my XMPP account
    Given my XMPP friend goes online
    When I start a conversation with my friend
    And I say something to my friend
    Then I receive a response from my friend

  @check_tor_leaks
  Scenario: Using a persistent Pidgin configuration
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And the network is plugged
    And Tor is ready
    And available upgrades have been checked
    And all notifications have disappeared
    When I start "Pidgin Internet Messenger" via GNOME Activities Overview
    Then I see Pidgin's account manager window
    When I create my XMPP account
    And I close Pidgin's account manager window
    Then Pidgin automatically enables my XMPP account
    When I close Pidgin
    And I take note of the configured Pidgin accounts
    And I shutdown Tails and wait for the computer to power off
    Given a computer
    And I start Tails from USB drive "__internal" and I login with persistence enabled
    And Pidgin has the expected persistent accounts configured
    When I start "Pidgin Internet Messenger" via GNOME Activities Overview
    Then Pidgin automatically enables my XMPP account
