@product
Feature: Onion Circuits

  Scenario: Onion Circuits shows some circuits
    Given I have started Tails from DVD and logged in and the network is connected
    When I start "Onion Circuits" via GNOME Activities Overview
    Then Onion Circuits starts
    And Onion Circuits shows some circuits
