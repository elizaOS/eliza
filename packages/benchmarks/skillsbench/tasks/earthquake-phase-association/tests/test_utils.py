from datetime import datetime

import numpy as np
import pandas as pd

TIME_THRESHOLD = 5  # s


def timestamp(dt):
    return (dt.replace(tzinfo=None) - datetime(2019, 1, 1)).total_seconds()


def calc_detection_performance(t_pred, t_true, time_accuracy_threshold=3):
    # time_accuracy_threshold = 3 #s
    evaluation_matrix = np.abs(t_pred[np.newaxis, :] - t_true[:, np.newaxis]) < time_accuracy_threshold  # s
    recalls = np.sum(evaluation_matrix, axis=1) > 0
    num_recall = np.sum(recalls)
    num_precision = np.sum(np.sum(evaluation_matrix, axis=0) > 0)
    if (len(t_true) > 0) and (len(t_pred) > 0):
        recall = num_recall / len(t_true)
        precision = num_precision / len(t_pred)
        f1 = 2 * recall * precision / (recall + precision)
    return recall, precision, f1


def filter_catalog(catalog, start_datetime, end_datetime):
    selected_catalog = catalog[(catalog["date"] >= start_datetime) & (catalog["date"] <= end_datetime)]
    print(f"Filtered catalog {start_datetime}-{end_datetime}: {len(selected_catalog)} events")

    t_event = []
    for _, row in selected_catalog.iterrows():
        t_event.append(timestamp(row["date"]))
    t_event = np.array(t_event)

    return t_event, selected_catalog


def load_catalog(fname):
    catalog = pd.read_csv(fname)
    catalog["date"] = catalog["time"].map(datetime.fromisoformat)
    return catalog


def test(start_datetime: str = "2019-07-04T19:00:00", end_datetime: str = "2019-07-04T20:00:00"):
    gamma_events_csv = "/root/results.csv"
    scsn_events_csv = "/tests/catalog.csv"
    ## read catalaogs
    t_gamma, catalog_gamma = filter_catalog(
        load_catalog(gamma_events_csv),
        start_datetime,
        end_datetime,
    )
    catalog_gamma["time"] = catalog_gamma["time"].apply(lambda x: datetime.fromisoformat(x))
    t_scsn, catalog_scsn = filter_catalog(
        load_catalog(scsn_events_csv),
        start_datetime,
        end_datetime,
    )
    time_threshold = TIME_THRESHOLD
    recall, precision, f1 = calc_detection_performance(t_gamma, t_scsn, time_threshold)
    return recall, precision, f1
