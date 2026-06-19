#!/usr/bin/python3

import argparse
import json
import logging
import re
import sys
from pathlib import Path

import requests


class CveFetcher:
    baseurl = "https://services.nvd.nist.gov/rest/json/cves/2.0"

    def __init__(self):
        self.log = logging.getLogger(self.__class__.__name__)

    def get_parser(self) -> argparse.ArgumentParser:
        p = argparse.ArgumentParser(
            formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        )
        p.add_argument(
            "--config-dir",
            type=Path,
            default=str(Path("~/.local/share/cve-scraper/").expanduser()),
        )
        p.add_argument(
            "--log-level",
            choices=["DEBUG", "INFO", "WARN", "ERROR"],
            default="INFO",
        )
        p.set_defaults(func=None)
        sub = p.add_subparsers()

        fetch = sub.add_parser("fetch")
        fetch.set_defaults(func=self.main_fetch)
        fetch.add_argument("--overwrite", action="store_true", default=False)
        fetch.add_argument("cveid", help="Example: CVE-2014-0160", nargs="+")

        cat = sub.add_parser("cat")
        cat.add_argument("cveid", help="Example: CVE-2014-0160", nargs="+")
        cat.set_defaults(func=self.main_cat)

        search = sub.add_parser("search")
        search.set_defaults(func=self.main_search)
        output = search.add_argument_group("output")
        output.add_argument(
            "--output-cve",
            default="cveid",
            choices=["cveid", "nvd-url", "nvd-json"],
            help="What to display",
        )

        results = search.add_argument_group("results")
        results.add_argument(
            "--show-missing-data",
            action="store_true",
            default=False,
            help=(
                "This will include CVEs for which we don't have relevant metrics"
                "as positive matches"
            ),
        )
        results.add_argument(
            "--skip-missing-data",
            action="store_true",
            default=False,
            help=("This will skip CVEs for which we don't have relevant metrics"),
        )

        query = search.add_argument_group("query")
        query.add_argument(
            "--vector-includes",
            metavar="REGEXP",
            type=re.compile,
            default=[],
            action="append",
            help=(
                "Matches the attack vector string.\n"
                "May be given multiple times: if so, all of them must match\n"
                "Example: --vector-includes 'AV:[LR]' --vector-includes 'C:[MH]'\n"
            ),
        )
        query.add_argument(
            "--description",
            metavar="REGEXP",
            type=lambda s: re.compile(s, flags=re.IGNORECASE),
            help="Filter CVEs whose description matches this regexp (case-insensitive)",
        )

        query.add_argument("--min-score", type=float)
        query.add_argument(
            "--min-confidentiality-impact",
            choices=["LOW", "MEDIUM", "HIGH"],
        )
        query.add_argument("--min-integrity-impact", choices=["LOW", "MEDIUM", "HIGH"])
        query.add_argument(
            "--min-availability-impact",
            choices=["LOW", "MEDIUM", "HIGH"],
        )
        search.add_argument("cveid", help="Example: CVE-2014-0160", nargs="+")
        return p

    def get_path_for_cve(self, cve: str):
        return self.args.config_dir / "nvd" / f"{cve}.json"

    def fetch(self, session, cve: str):
        fpath = self.get_path_for_cve(cve)
        if not self.args.overwrite and fpath.exists():
            self.log.debug("%s already downloaded, skipping", cve)
            return
        resp = session.get(self.baseurl, params={"cveId": cve}, timeout=30)
        if not resp.ok:
            self.log.warning("Could not fetch %s", cve)
            return
        content = resp.json()  # check if json is valid
        try:
            cve_content = content["vulnerabilities"][0]["cve"]
        except (IndexError, KeyError):
            self.log.warning("%s has invalid content", cve)
            return
        with fpath.open(mode="w") as buf:
            json.dump(cve_content, buf, indent=2)

    def main(self):
        p = self.get_parser()
        self.args = p.parse_args()
        logging.basicConfig(level=self.args.log_level)

        if self.args.func is None:
            print("No subcommand specified")
            p.print_usage()
            sys.exit(1)
        self.args.func()

    def main_fetch(self):
        self.args.config_dir.mkdir(exist_ok=True)
        (self.args.config_dir / "nvd").mkdir(exist_ok=True)
        session = requests.Session()
        for cve in self.args.cveid:
            self.fetch(session, cve)

    def vuln_match(self, vuln: dict) -> bool:
        impact_to_number = {
            "NONE": 0,
            "LOW": 10,
            "MEDIUM": 20,
            "HIGH": 30,
        }

        if self.args.description:
            all_descriptions = vuln["descriptions"]
            english_descriptions = [
                d["value"] for d in all_descriptions if d["lang"] == "en"
            ]
            if english_descriptions:
                description = "\n".join(english_descriptions)
            else:
                description = "\n".join(all_descriptions)
            if self.args.description.search(description) is None:
                return False

        if not vuln["metrics"]:
            if self.args.show_missing_data:
                return True
            metrics = None
        else:
            metrics = vuln["metrics"]["cvssMetricV31"][0]["cvssData"]

        if self.args.min_score is not None:
            if metrics is None:
                return False
            if metrics["baseScore"] < self.args.min_score:
                return False

        for impact in ["confidentiality", "integrity", "availability"]:
            option = getattr(self.args, f"min_{impact}_impact")
            if option is None:
                continue
            if metrics is None:
                return False
            metric = f"{impact}Impact"
            if impact_to_number[metrics[metric]] < impact_to_number[option]:
                return False

        if self.args.vector_includes:
            if metrics is None:
                return False
            if not metrics["vectorString"]:
                return self.args.show_missing_data
            vector_features = metrics["vectorString"].split("/")
            for regexp in self.args.vector_includes:
                if not any(bool(regexp.search(feature)) for feature in vector_features):
                    return False
        return True

    def output_cve(self, cve: str):
        match self.args.output_cve:
            case "cveid":
                print(cve)
            case "nvd-url":
                print(f"https://nvd.nist.gov/vuln/detail/{cve}")
            case "nvd-json":
                print(f"{self.baseurl}?cveId={cve}")

    def main_cat(self):
        for cve in self.args.cveid:
            path = self.get_path_for_cve(cve)
            print(path.open().read())

    def main_search(self):
        ignored = []
        for cve in self.args.cveid:
            self.log.debug("Analyzing %s", cve)
            path = self.get_path_for_cve(cve)
            if not path.exists():
                if self.args.skip_missing_data:
                    ignored.append(path)
                    continue
                self.log.error("You should fetch %s first", cve)
                sys.exit(1)
            try:
                vuln = json.load(path.open())
            except json.JSONDecodeError:
                self.log.error(  # noqa: TRY400
                    "Error decoding %s - please analyze and remove",
                    path,
                )
                if self.args.skip_missing_data:
                    ignored.append(path)
                    continue
                sys.exit(1)
            if self.vuln_match(vuln):
                self.output_cve(cve)
        if ignored:
            logging.warning(
                "%d CVEs (out of %d) have been ignored",
                len(ignored),
                len(self.args.cveid),
            )


if __name__ == "__main__":
    CveFetcher().main()
