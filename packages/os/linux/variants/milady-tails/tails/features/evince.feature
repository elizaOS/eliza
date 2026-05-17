@product
Feature: Using Evince
  As a Tails user
  I want to view and print PDF files in Evince

  Scenario: I can view and print a PDF file stored in /usr/share
    Given I have started Tails from DVD without network and logged in
    When I open "/usr/share/cups/data/default-testpage.pdf" with Evince
    Then I see "CupsTestPage.png" after at most 40 seconds
    And I can print the current document to "/home/amnesia/output.pdf"

  Scenario: I can view and print a PDF file stored in non-persistent /home/amnesia
    Given I have started Tails from DVD without network and logged in
    And I copy "/usr/share/cups/data/default-testpage.pdf" to "/home/amnesia" as user "amnesia"
    When I open "/home/amnesia/default-testpage.pdf" with Evince
    Then I see "CupsTestPage.png" after at most 40 seconds
    And I can print the current document to "/home/amnesia/output.pdf"

  Scenario: I can view and print a PDF file stored in persistent /home/amnesia/Persistent
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    And I copy "/usr/share/cups/data/default-testpage.pdf" to "/home/amnesia/Persistent" as user "amnesia"
    Then the file "/home/amnesia/Persistent/default-testpage.pdf" exists
    When I open "/home/amnesia/Persistent/default-testpage.pdf" with Evince
    Then I see "CupsTestPage.png" after at most 40 seconds
    And I can print the current document to "/home/amnesia/Persistent/output.pdf"
