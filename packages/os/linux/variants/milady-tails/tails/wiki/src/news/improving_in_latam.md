[[!meta  title="Improving Tails for human rights defenders in Latin America"]]
[[!meta  date="Tue, 06 Jun 2023 14:00:00 +0000"]]
[[!pagetemplate template="news.tmpl"]]
[[!tag announce]]

Between 2021 and 2023 Tails, [Tor](https://torproject.org/), and the [Guardian
Project](https://guardianproject.info/) partnered to organize training and
usability tests in Ecuador, Mexico, and Brazil. Our goals were to:

- Promote our digital security tools and train human rights defenders in the
  Global South.

- Learn from their experiences and needs to help us prioritize future work.

- Improve the usability of our tools based on their feedback.

Usability tests and improvements
================================

We conducted 4 rounds of in-person moderated usability tests in Mexico, Brazil,
and Ecuador to identify usability issues in the features of Tails that are most
important to new users:

- Installation

- Tor Connection

- Persistent Storage

The DesignOps tools that we used to organize these usability tests are all
[[publicly available on our website|contribute/how/user_experience]].

The detailed methodology for each of the usability tests is explained in the
corresponding GitLab issues, linked below.

### Installation

In December 2021 in Mexico, we learned that the tools for new users to install
Tails worked well, but several people got lost while navigating the
instructions on the website.

Based on these findings, we restructured our installation pages and fixed 30
usability issues on the website.

We tested these improvements in August 2022 in Brazil and confirmed that the
new installation pages were much easier to follow. Only 1 out of 4 participants
had trouble installing Tails on their own. All participants could start Tails
and connect to the Tor network easily.

Details:

- Usability tests of first-time use in Mexico ([[!tails_ticket 18074]])
  * [Summary of findings](https://gitlab.tails.boum.org/tails/tails/-/issues/18074#note_210738)
  * [Detailed findings](https://gitlab.tails.boum.org/tails/ux/-/raw/master/first-time/rainbow_table_installation_2021_08_Mexico.fods?inline=false)

- Usability tests of first-time use in Brazil ([[!tails_ticket 18784]])
  * [Summary of findings](https://lists.autistici.org/message/20221012.181235.a673efeb.en.html)
  * [Detailed findings](https://gitlab.tails.boum.org/tails/ux/-/blob/master/first-time/rainbow_table_installation_2022_08_Sao_Paulo.fods?inline=false)

### Tor Connection

In July 2021, we released the Tor Connection assistant to completely redesign
how to connect Tails to the Tor network. The new assistant is most useful to
people who are at high risk of physical surveillance, under heavy network
censorship, or on a poor Internet connection.

In August 2022 in Brazil, we tested the usability of Tor Connection when
accessing the Tor network is blocked by censorship or by a captive portal.

Despite the many usability issues that we fixed since the first release of Tor
Connection, 3 test participants out of 4 failed to connect when access to the
Tor network was blocked.

Since then we fixed 14 usability issues affecting Tor Connection: to understand
better why connecting to Tor fails, to make it easier to configure a Tor
bridge, and to make it easier to sign in to a network using a captive portal.

- Usability tests of Tor Connection ([[!tails_ticket 18762]])
  * [Summary of findings](https://lists.autistici.org/message/20221012.140611.7e58f067.en.html)
  * [Detailed findings](https://gitlab.tails.boum.org/tails/ux/-/raw/master/network/rainbow_table_tor_connection_2022_08_Sao_Paulo.ods?inline=false)

### Persistent Storage

In March 2023 in Ecuador, we tested the usability of the new Persistent
Storage, which was released in Tails in December 2022.

We didn't find any serious usability issues in the new Persistent Storage. The
fact that people don't have to restart to create and enable the Persistent
Storage and that their data (eg. Wi-Fi password) is stored on creation were
huge improvements compared to the old Persistent Storage.

- March 2023: Usability tests of the new Persistent Storage ([[!tails_ticket 18648]])
  * [Summary of findings](https://lists.autistici.org/message/20230510.091842.23ed75ba.en.html)
  * [Detailed findings](https://gitlab.tails.boum.org/tails/ux/-/raw/master/persistent%20storage/rainbow_table_persistent_storage_2023_03_Ecuador.fods?inline=false)

Trainings
=========

Through our combined efforts we reached 47 organizations and trained 433 human
rights defenders on our family of tools based on the Tor network. For Tails
only, we conducted 8 workshops and trained 84 people on using Tails:
journalists, activists, feminists, lawyers, and human rights defenders.

The material used for these Tails workshops is available on our website in
[English](https://tails.net/contribute/how/promote/slides/Ciclo_Autodefensa_Digital_202204/Tails-English.odp),
[Spanish](https://tails.net/contribute/how/promote/slides/Ciclo_Autodefensa_Digital_202204/Tails-Spanish.odp), and
[Portuguese](https://tails.net/contribute/how/promote/slides/Ciclo_Autodefensa_Digital_202204/Tails-Portuguese.odp).

Assistants to the workshops were able to start Tails on all their PC computers
but had more frequent issues with Mac computers.

From what is already possible to do with Tails, people were most interested in
using Tails to:

- Handle sensitive data, for example, medical data of abortion patients,
  sensitive documents from political trials, or field studies from human rights
  violations. That said, not all journalists thought that they were
  manipulating data that was sensitive enough to require a tool like Tails.
  Sometimes it was hard to draw the line on when to use Tails and when not.

- Investigate sensitive topics online, either for journalistic purposes, medical
  purposes, or when making safe travel plans.

- Have a secure OS when using other people's computer, either when traveling or
  when people don't have the means to have their own computer.

From what is not possible yet to do with Tails, people were most interested in:

- Doing online meetings and using mobile messaging apps like Signal and
  Telegram from Tails.

- Using a VPN instead of Tor for speed and access to more websites.

We included both of these objectives in our 3-year product strategy.
You can track our progress in the GitLab issues related to
[[!tails_ticket 19472]].
