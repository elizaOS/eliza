#!/usr/bin/python3 -I

import sys
import unittest

print(sys.path)
import whisperBack.utils


class TestIsValidLink(unittest.TestCase):
    def test_valid_http(self):
        self.assertTrue(whisperBack.utils.is_valid_link("http://test.example.org/"))

    def test_valid_ftp(self):
        self.assertTrue(whisperBack.utils.is_valid_link("ftp://test.example.org/"))

    def test_valid_https(self):
        self.assertTrue(whisperBack.utils.is_valid_link("https://test.example.org/"))

    def test_valid_ftps(self):
        self.assertTrue(whisperBack.utils.is_valid_link("ftps://test.example.org/"))

    def test_wrong_scheme(self):
        self.assertFalse(whisperBack.utils.is_valid_link("error://test.example.org/"))

    def test_valid_domain2(self):
        self.assertTrue(whisperBack.utils.is_valid_link("http://example.org/"))

    def test_wrong_domain(self):
        self.assertFalse(whisperBack.utils.is_valid_link("ftp://example_org/"))

    def test_wrong_domain(self):
        self.assertFalse(whisperBack.utils.is_valid_link("ftp://example_org/"))


class TestSanitiseHardwareInfo(unittest.TestCase):
    def test_iptables_ip(self):
        sanitized_log = whisperBack.utils.sanitize_hardware_info(
            "[  958.314027] Dropped outbound packet: IN= OUT=lo SRC=189.67.1.123 DST=127.0.0.1 LEN=80 TOS=0x00 PREC=0xC0 TTL=64 ID=54418 PROTO=ICMP TYPE=3 CODE=3 [SRC=18.165.88.98 DST=123.138.117.98 LEN=52 TOS=0x00 PREC=0x00 TTL=64 ID=35937 DF PROTO=TCP SPT=44880 DPT=8118 WINDOW=383 RES=0x00 ACK FIN URGP=0 ]"
        )
        self.assertTrue(
            "189.67.1.123" not in sanitized_log
            and "127.0.0.1" not in sanitized_log
            and "18.165.88.98" not in sanitized_log
            and "123.138.117.98" not in sanitized_log
        )

    def test_iptables_ipv6(self):
        sanitized_log = whisperBack.utils.sanitize_hardware_info(
            "[   12.3456789] Dropped outbound packet: IN= OUT=eth0 SRC=fe80:0000:0000:0000:abcd:efab:cdef:1234 DST=ff02:0000:0000:0000:0000:0000:0000:0002 LEN=56 TC=0 HOPLIMIT=255 FLOWLBL=0 PROTO=ICMPv6 TYPE=133 CODE=0"
        )
        self.assertTrue(
            "fe80:0000:0000:0000:abcd:efab:cdef:1234" not in sanitized_log
            and "ff02:0000:0000:0000:0000:0000:0000:0002" not in sanitized_log
        )

    def test_usb_serial(self):
        self.assertTrue(
            "1234567890AB"
            not in whisperBack.utils.sanitize_hardware_info(
                "[  431.655363] usb 1-1: SerialNumber: 1234567890AB"
            )
        )

    @unittest.skip(
        "Not implemented yet see: https://gitlab.tails.boum.org/tails/tails/-/issues/6799"
    )
    def test_ata_serial(self):
        self.assertTrue(
            "123456789ABYZ"
            not in whisperBack.utils.sanitize_hardware_info(
                "ata3.00: ATA-8: Hitachi 123456789ABYZ, JP1234MA, max UDMA/133"
            )
        )

    def test_tveeprom_serial(self):
        self.assertTrue(
            "XXAZ09XX"
            not in whisperBack.utils.sanitize_hardware_info(
                "tveeprom 9-0050: Hauppauge model 78631, rev C1E9, serial# XXAZ09XX"
            )
        )

    def test_intel_serial(self):
        self.assertTrue(
            "XXXXAZ09XXXX"
            not in whisperBack.utils.sanitize_hardware_info(
                "(II) intel(0): Serial No: XXXXAZ09XXXX"
            )
        )

    def test_dmi(self):
        self.assertTrue(
            "1234ABYZ, BIOS 1234ABYZ.1234ABCDWXYZ.1234.5678.9012"
            not in whisperBack.utils.sanitize_hardware_info(
                "DMI:                  /1234ABYZ, BIOS 1234ABYZ.1234ABCDWXYZ.1234.5678.9012 12/22/2011"
            )
        )


if __name__ == "__main__":
    unittest.main()
