# python construct_data.py --hours 72 --machines 20 \
#   --sensors humidity,power,efficiency,noise_level,oil_pressure,speed \
#   --multi-anomaly --cascade-failure --noise \
#   --anomaly-rate 0.0005 --prefix training_set_v1


# python anomaly_detection.py --prefix training_set_v1 --start-time "2025-08-19 11:30" --end-time "2025-08-19 12:30"

python calculate_groundtruth.py