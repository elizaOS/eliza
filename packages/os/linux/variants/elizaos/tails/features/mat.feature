@product
Feature: Metadata Anonymization Toolkit
  As a Tails user
  I want to be able to remove leaky metadata from documents and media files

  @not_release_blocker
  Scenario: MAT can clean a PNG file
    Given a computer
    And I start Tails from DVD with network unplugged and I login
    And I plug and mount a USB drive containing a sample PNG
    Then MAT can clean some sample PNG file
