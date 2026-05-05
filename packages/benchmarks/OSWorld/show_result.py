import os
import argparse


def get_result(action_space, use_model, observation_type, result_dir, show_detailed_scores=False):
    """
    Calculate and display evaluation results from OSWorld benchmark runs.

    Args:
        action_space (str): Action space used (e.g., "pyautogui", "computer_13")
        use_model (str): Model name used for evaluation (e.g., "gpt-4o", "claude-3")
        observation_type (str): Observation type used (e.g., "screenshot", "a11y_tree")
        result_dir (str): Root directory containing results
        show_detailed_scores (bool): If True, show detailed scores per domain in format "score/total"

    Returns:
        list: List of all individual task results, or None if no results found
    """
    target_dir = os.path.join(result_dir, action_space, observation_type, use_model)
    if not os.path.exists(target_dir):
        print("New experiment, no result yet.")
        return None

    all_result = []
    domain_result = {}
    all_result_for_analysis = {}

    for domain in os.listdir(target_dir):
        domain_path = os.path.join(target_dir, domain)
        if os.path.isdir(domain_path):
            for example_id in os.listdir(domain_path):
                example_path = os.path.join(domain_path, example_id)
                if os.path.isdir(example_path):
                    if "result.txt" in os.listdir(example_path):
                        if domain not in domain_result:
                            domain_result[domain] = []
                        result = open(os.path.join(example_path, "result.txt"), "r").read()
                        try:
                            domain_result[domain].append(float(result))
                        except:
                            domain_result[domain].append(float(eval(result)))

                        if domain not in all_result_for_analysis:
                            all_result_for_analysis[domain] = {}
                        all_result_for_analysis[domain][example_id] = domain_result[domain][-1]

                        try:
                            result = open(os.path.join(example_path, "result.txt"), "r").read()
                            try:
                                all_result.append(float(result))
                            except:
                                all_result.append(float(bool(result)))
                        except:
                            all_result.append(0.0)

    if show_detailed_scores:
        # Print detailed scores in format "score/total" for each domain
        result_order = ["chrome", "gimp", "libreoffice_calc", "libreoffice_impress",
                       "libreoffice_writer", "multi_apps", "os", "thunderbird", "vlc", "vs_code"]
        output_row = []
        for d in result_order:
            if d in domain_result:
                output_row.append(f"{round(sum(domain_result[d]),2)}/{len(domain_result[d])}")
            else:
                output_row.append("0.00/0")
        print(" ".join(output_row))
    else:
        # Print standard per-domain statistics
        for domain in domain_result:
            print("Domain:", domain, "Runned:", len(domain_result[domain]), "Success Rate:",
                  sum(domain_result[domain]) / len(domain_result[domain]) * 100, "%")

    print(">>>>>>>>>>>>>")

    # Print category-level statistics
    if all(d in domain_result for d in ["libreoffice_calc", "libreoffice_impress", "libreoffice_writer"]):
        print("Office", "Success Rate:", sum(
            domain_result["libreoffice_calc"] + domain_result["libreoffice_impress"] + domain_result[
                "libreoffice_writer"]) / len(
            domain_result["libreoffice_calc"] + domain_result["libreoffice_impress"] + domain_result[
                "libreoffice_writer"]) * 100, "%")

    if all(d in domain_result for d in ["vlc", "thunderbird", "chrome"]):
        print("Daily", "Success Rate:",
              sum(domain_result["vlc"] + domain_result["thunderbird"] + domain_result["chrome"]) / len(
                  domain_result["vlc"] + domain_result["thunderbird"] + domain_result["chrome"]) * 100, "%")

    if all(d in domain_result for d in ["gimp", "vs_code"]):
        print("Professional", "Success Rate:", sum(domain_result["gimp"] + domain_result["vs_code"]) / len(
            domain_result["gimp"] + domain_result["vs_code"]) * 100, "%")

    with open(os.path.join(target_dir, "all_result.json"), "w") as f:
        f.write(str(all_result_for_analysis))

    if not all_result:
        print("New experiment, no result yet.")
        return None
    else:
        print("Runned:", len(all_result), "Current Success Rate:",
              round(sum(all_result) / len(all_result) * 100, 2), "%",
              f"{round(sum(all_result), 2)}", "/", str(len(all_result)))
        return all_result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description="Calculate and display OSWorld evaluation results"
    )
    parser.add_argument(
        "--action_space",
        type=str,
        default="pyautogui",
        help="Action space used (e.g., 'pyautogui', 'computer_13')"
    )
    parser.add_argument(
        "--model",
        type=str,
        default="gpt-4o",
        help="Model name used for evaluation (e.g., 'gpt-4o', 'claude-3')"
    )
    parser.add_argument(
        "--observation_type",
        type=str,
        default="screenshot",
        help="Observation type used (e.g., 'screenshot', 'a11y_tree', 'som')"
    )
    parser.add_argument(
        "--result_dir",
        type=str,
        default="./results",
        help="Root directory containing results (default: ./results)"
    )
    parser.add_argument(
        "--detailed",
        action="store_true",
        help="Show detailed scores per domain in format 'score/total'"
    )

    args = parser.parse_args()

    get_result(
        args.action_space,
        args.model,
        args.observation_type,
        args.result_dir,
        args.detailed
    )
