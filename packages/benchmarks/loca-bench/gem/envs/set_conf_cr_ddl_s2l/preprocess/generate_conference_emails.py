#!/usr/bin/env python3
"""
Conference Deadline Email Generator

Generate emails containing camera-ready deadlines for different conferences
Supports difficulty control: number of conferences, noise emails, deadline changes, etc.
"""

import json
import random
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict
from argparse import ArgumentParser, RawDescriptionHelpFormatter


class ConferenceEmailGenerator:
    """Conference Email Generator"""

    # Base conference information templates
    BASE_CONFERENCES = {
        'COML': {
            'full_name': 'Conference on Machine Learning',
            'acronym': 'COML',
            'track_types': ['main-track', 'workshop', 'demo'],
            'organizer': 'coml-chairs@ml-conference.org',
            'website': 'https://coml2025.org'
        },
        'NLPR': {
            'full_name': 'Natural Language Processing Research Conference',
            'acronym': 'NLPR',
            'track_types': ['main-track', 'short-paper', 'industry'],
            'organizer': 'nlpr-committee@nlp-research.org',
            'website': 'https://nlpr2025.org'
        },
        'CVAI': {
            'full_name': 'Computer Vision and AI Symposium',
            'acronym': 'CVAI',
            'track_types': ['main-track', 'workshop', 'poster'],
            'organizer': 'cvai-organizers@vision-ai.org',
            'website': 'https://cvai2025.org'
        },
        'DLNN': {
            'full_name': 'Deep Learning and Neural Networks Conference',
            'acronym': 'DLNN',
            'track_types': ['main-track', 'tutorial', 'demo'],
            'organizer': 'dlnn-chairs@deeplearning.org',
            'website': 'https://dlnn2025.org'
        },
        'ROBO': {
            'full_name': 'International Conference on Robotics',
            'acronym': 'ROBO',
            'track_types': ['main-track', 'application', 'workshop'],
            'organizer': 'robo-committee@robotics.org',
            'website': 'https://robo2025.org'
        },
        'DATA': {
            'full_name': 'Big Data Analytics Conference',
            'acronym': 'DATA',
            'track_types': ['main-track', 'industry', 'poster'],
            'organizer': 'data-chairs@bigdata-conf.org',
            'website': 'https://data2025.org'
        }
    }
    
    # Conference topic templates (used to generate more conferences)
    CONFERENCE_TOPICS = [
        # AI & ML
        'Machine Learning', 'Deep Learning', 'Neural Networks', 'Computer Vision',
        'Natural Language Processing', 'Reinforcement Learning', 'Transfer Learning',
        'Meta Learning', 'Few-Shot Learning', 'Self-Supervised Learning',
        'Generative AI', 'Large Language Models', 'Multimodal Learning',
        'Graph Neural Networks', 'Attention Mechanisms', 'Transformer Models',
        
        # Robotics & Automation
        'Robotics', 'Autonomous Systems', 'Robot Learning', 'Human-Robot Interaction',
        'Swarm Intelligence', 'Drone Systems', 'Industrial Automation',
        
        # Data & Analytics
        'Data Science', 'Big Data', 'Data Mining', 'Text Mining', 'Stream Processing',
        'Data Visualization', 'Business Analytics', 'Predictive Analytics',
        'Time Series Analysis', 'Anomaly Detection', 'Clustering Analysis',
        
        # Software & Systems
        'Software Engineering', 'Distributed Systems', 'Database Systems',
        'Operating Systems', 'Parallel Computing', 'Grid Computing',
        'High Performance Computing', 'Scientific Computing',
        
        # Cloud & Infrastructure
        'Cloud Computing', 'Edge Computing', 'Fog Computing', 'Serverless Computing',
        'Cloud Native', 'DevOps', 'Microservices', 'Containerization',
        'Service Mesh', 'Infrastructure as Code',
        
        # Security & Privacy
        'Cybersecurity', 'Network Security', 'Information Security', 'Privacy Preserving',
        'Cryptography', 'Blockchain', 'Digital Forensics', 'Threat Intelligence',
        
        # Networks & Communications
        'Network Protocols', 'Wireless Networks', '5G Networks', '6G Networks',
        'Mobile Computing', 'Sensor Networks', 'IoT', 'Network Optimization',
        
        # Web & Multimedia
        'Web Technologies', 'Web Services', 'Semantic Web', 'Social Media',
        'Multimedia Systems', 'Graphics', 'Image Processing', 'Video Analysis',
        'Audio Processing', 'Speech Recognition', 'Music Information Retrieval',
        
        # Extended Reality
        'Virtual Reality', 'Augmented Reality', 'Mixed Reality', 'Haptic Systems',
        'Game Development', '3D Graphics', 'Computer Animation',
        
        # Specialized Domains
        'Bioinformatics', 'Computational Biology', 'Healthcare Informatics',
        'Medical Imaging', 'Drug Discovery', 'Genomics', 'Proteomics',
        'Smart Cities', 'Urban Computing', 'Transportation Systems',
        'Energy Systems', 'Environmental Informatics', 'Climate Modeling',
        'Financial Technology', 'Algorithmic Trading', 'Risk Management',
        
        # Human-Centered Computing
        'Human-Computer Interaction', 'User Experience', 'Accessibility',
        'Social Computing', 'Collaborative Systems', 'Crowdsourcing',
        'Recommender Systems', 'Personalization', 'Sentiment Analysis',
        
        # Information & Knowledge
        'Information Retrieval', 'Knowledge Management', 'Knowledge Graphs',
        'Question Answering', 'Information Extraction', 'Document Analysis',
        'Search Engines', 'Ontology Engineering',
        
        # Emerging Technologies
        'Quantum Computing', 'Neuromorphic Computing', 'DNA Computing',
        'Optical Computing', 'Brain-Computer Interfaces', 'Wearable Computing',
        'Affective Computing', 'Pervasive Computing', 'Ubiquitous Computing'
    ]
    
    CONFERENCE_TYPES = [
        'Conference', 'Symposium', 'Workshop', 'Summit', 'Congress',
        'Forum', 'Colloquium', 'Meeting', 'Convention'
    ]
    
    def __init__(self, seed: int = 42, max_conferences: int = 200):
        random.seed(seed)
        self.seed = seed
        self.max_conferences = max_conferences
        self.CONFERENCES = self._generate_conferences()
    
    def _generate_conferences(self) -> Dict:
        """Dynamically generate conference list"""
        conferences = self.BASE_CONFERENCES.copy()
        
        # Generate additional conferences
        used_acronyms = set(conferences.keys())

        for i in range(self.max_conferences - len(self.BASE_CONFERENCES)):
            # Randomly select topic and type
            topic = random.choice(self.CONFERENCE_TOPICS)
            conf_type = random.choice(self.CONFERENCE_TYPES)
            
            # Generate acronym (take first letters)
            words = topic.split()
            if len(words) >= 2:
                acronym = ''.join([w[0] for w in words[:min(4, len(words))]])
            else:
                acronym = words[0][:4].upper()
            
            # If acronym is duplicate, add numeric suffix
            base_acronym = acronym
            counter = 1
            while acronym in used_acronyms:
                acronym = f"{base_acronym}{counter}"
                counter += 1
            
            used_acronyms.add(acronym)
            
            # Generate conference information
            conferences[acronym] = {
                'full_name': f"International {conf_type} on {topic}",
                'acronym': acronym,
                'track_types': random.sample(
                    ['main-track', 'workshop', 'demo', 'short-paper', 'industry', 'poster', 'tutorial', 'application'],
                    k=random.randint(3, 5)
                ),
                'organizer': f"{acronym.lower()}-chairs@{topic.lower().replace(' ', '-')}-conf.org",
                'website': f"https://{acronym.lower()}2025.org"
            }
        
        return conferences
    
    def generate_deadline(self, base_date: datetime, days_offset: int = 15) -> str:
        """Generate deadline (ISO format)"""
        deadline = base_date + timedelta(days=days_offset)
        # Use AoE timezone (UTC-12)
        return f"{deadline.strftime('%Y-%m-%d')}T23:59:00-12:00"
    
    def generate_camera_ready_email(self, 
                                    conference_key: str,
                                    track: str,
                                    deadline: str,
                                    email_date: str,
                                    is_reminder: bool = False,
                                    is_extension: bool = False,
                                    old_deadline: str = None) -> Dict:
        """Generate camera-ready email"""
        conf = self.CONFERENCES[conference_key]
        
        if is_extension:
            subject = f"[{conf['acronym']} {track}] Camera-Ready Deadline EXTENDED"
            body = f"""Dear Author,

We are writing to inform you that the camera-ready deadline for {conf['full_name']} {track} has been EXTENDED.

Original deadline: {old_deadline}
NEW deadline: {deadline}

Please prepare your final camera-ready manuscript by the new deadline.

Best regards,
{conf['full_name']} Organizing Committee
{conf['organizer']}
Website: {conf['website']}
"""
        elif is_reminder:
            subject = f"[{conf['acronym']} {track}] REMINDER: Camera-Ready Deadline Approaching"
            body = f"""Dear Author,

This is a friendly reminder that the camera-ready deadline for {conf['full_name']} {track} is approaching.

Deadline: {deadline}

Please ensure you submit your final camera-ready manuscript before the deadline.

Best regards,
{conf['full_name']} Organizing Committee
{conf['organizer']}
Website: {conf['website']}
"""
        else:
            subject = f"[{conf['acronym']} {track}] Camera-Ready Submission Instructions"
            body = f"""Dear Author,

Congratulations on your paper acceptance to {conf['full_name']} {track}!

Please submit your camera-ready manuscript by:
Deadline: {deadline}

Submission requirements:
- Format: PDF (max 10 pages)
- Follow the camera-ready guidelines on our website
- Include author information and acknowledgments
- Sign the copyright form

Best regards,
{conf['full_name']} Organizing Committee
{conf['organizer']}
Website: {conf['website']}
"""
        
        # Generate unique email ID
        email_id = f"email_{conference_key}_{track}_{random.randint(1000, 9999)}"
        
        return {
            'email_id': email_id,
            'subject': subject,
            'from_addr': conf['organizer'],
            'to_addr': None,  # Will be set in main function
            'date': email_date,
            'body_text': body,
            'body_html': f"<html><body><pre>{body}</pre></body></html>",
            'folder': 'INBOX',
            'is_read': False,
            'is_important': False,
            'message_id': f"<{email_id}@{conf['organizer'].split('@')[1]}>",
            'attachments': []
        }
    
    def generate_noise_email(self, 
                            conference_key: str,
                            email_date: str,
                            noise_type: str = 'general') -> Dict:
        """Generate noise email (not camera-ready related)"""
        conf = self.CONFERENCES[conference_key]
        
        noise_templates = {
            'general': {
                'subject': f"[{conf['acronym']}] Conference Update",
                'body': f"""Dear Participant,

We have some general updates about {conf['full_name']}.

Registration is now open. Early bird discount available until next month.

Best regards,
{conf['full_name']} Team
"""
            },
            'workshop': {
                'subject': f"[{conf['acronym']} Workshop] Call for Participation",
                'body': f"""Dear Researcher,

We invite you to participate in the workshops at {conf['full_name']}.

Workshop submission deadline: TBD

Best regards,
Workshop Chairs
"""
            },
            'registration': {
                'subject': f"[{conf['acronym']}] Registration Reminder",
                'body': f"""Dear Author,

Don't forget to register for {conf['full_name']}.

Early registration deadline: Soon

Best regards,
Registration Team
"""
            }
        }
        
        template = noise_templates.get(noise_type, noise_templates['general'])
        email_id = f"noise_{conference_key}_{noise_type}_{random.randint(1000, 9999)}"
        
        return {
            'email_id': email_id,
            'subject': template['subject'],
            'from_addr': conf['organizer'],
            'to_addr': None,
            'date': email_date,
            'body_text': template['body'],
            'body_html': f"<html><body><pre>{template['body']}</pre></body></html>",
            'folder': 'INBOX',
            'is_read': random.choice([True, False]),
            'is_important': False,
            'message_id': f"<{email_id}@{conf['organizer'].split('@')[1]}>",
            'attachments': []
        }
    
    def generate_emails(self,
                       num_target_conferences: int = 1,
                       num_noise_conferences: int = 2,
                       num_noise_emails_per_conf: int = 2,
                       enable_reminders: bool = False,
                       enable_extensions: bool = False,
                       base_date: datetime = None,
                       target_deadline_offset: int = 15) -> Dict:
        """
        Generate email collection

        Args:
            num_target_conferences: Number of conferences with actual camera-ready deadlines
            num_noise_conferences: Number of noise conferences (without target information)
            num_noise_emails_per_conf: Number of noise emails per conference
            enable_reminders: Whether to send reminder emails (increases difficulty)
            enable_extensions: Whether to include deadline extensions (increases difficulty)
            base_date: Base date
            target_deadline_offset: Target deadline offset in days
        """
        if base_date is None:
            base_date = datetime(2025, 9, 15)  # Default base date

        emails = []
        target_conferences_list = []  # Store all target conference information

        # Select conferences
        all_conf_keys = list(self.CONFERENCES.keys())
        random.shuffle(all_conf_keys)
        
        target_conf_keys = all_conf_keys[:num_target_conferences]
        noise_conf_keys = all_conf_keys[num_target_conferences:num_target_conferences + num_noise_conferences]
        
        print(f"Target conferences (with camera-ready deadline): {', '.join(target_conf_keys)}")
        print(f"Noise conferences (without target information): {', '.join(noise_conf_keys)}")
        
        # Generate emails for target conferences (with camera-ready deadline)
        for i, conf_key in enumerate(target_conf_keys):
            conf = self.CONFERENCES[conf_key]
            track = random.choice(conf['track_types'])
            
            # First conference uses main-track
            if i == 0:
                track = 'main-track'
            
            # Generate deadline
            deadline = self.generate_deadline(base_date, target_deadline_offset + i * 2)
            
            # Save conference information
            conference_info = {
                'conference': conf_key,
                'track': track,
                'deadline': deadline,
                'full_name': conf['full_name']
            }
            
            # Email send date (a few days before deadline)
            email_date_dt = base_date - timedelta(days=random.randint(1, 3))
            email_date = email_date_dt.strftime('%Y-%m-%d %H:%M:%S')
            
            # Main email
            email = self.generate_camera_ready_email(
                conf_key, track, deadline, email_date
            )
            emails.append(email)

            # Process extension first (if enabled), so subsequent reminder emails can use the correct deadline
            final_deadline = deadline
            extension_date_dt = None
            if enable_extensions and random.random() < 0.5:
                old_deadline = deadline
                final_deadline = self.generate_deadline(base_date, target_deadline_offset + i * 2 + 3)
                extension_date_dt = base_date - timedelta(days=random.randint(0, 1))
                extension_date = extension_date_dt.strftime('%Y-%m-%d %H:%M:%S')

                extension_email = self.generate_camera_ready_email(
                    conf_key, track, final_deadline, extension_date,
                    is_extension=True, old_deadline=old_deadline
                )
                emails.append(extension_email)

                # Update deadline in conference information
                conference_info['deadline'] = final_deadline

            # Then process reminder emails (determine which deadline to use based on reminder date)
            if enable_reminders:
                reminder_date_dt = base_date - timedelta(days=random.randint(0, 1))
                reminder_date = reminder_date_dt.strftime('%Y-%m-%d %H:%M:%S')

                # If reminder is sent after extension, use the extended deadline
                if extension_date_dt and reminder_date_dt >= extension_date_dt:
                    reminder_deadline = final_deadline
                else:
                    reminder_deadline = deadline

                reminder_email = self.generate_camera_ready_email(
                    conf_key, track, reminder_deadline, reminder_date, is_reminder=True
                )
                emails.append(reminder_email)
            
            # Add to target conference list
            target_conferences_list.append(conference_info)
        
        # Generate emails for noise conferences (without camera-ready information)
        for conf_key in noise_conf_keys:
            num_emails = random.randint(1, num_noise_emails_per_conf)
            
            for _ in range(num_emails):
                noise_type = random.choice(['general', 'workshop', 'registration'])
                email_date_dt = base_date - timedelta(days=random.randint(0, 5))
                email_date = email_date_dt.strftime('%Y-%m-%d %H:%M:%S')
                
                noise_email = self.generate_noise_email(conf_key, email_date, noise_type)
                emails.append(noise_email)
        
        # Sort by date (oldest first)
        emails.sort(key=lambda x: x['date'])
        
        # Generate metadata
        metadata = {
            'base_date': base_date.strftime('%Y-%m-%d'),
            'total_emails': len(emails),
            'target_info': {
                'conferences': target_conferences_list,  # All target conference list
                'count': num_target_conferences
            },
            'noise_info': {
                'conferences': noise_conf_keys,  # Noise conference list
                'count': num_noise_conferences,
                'emails_per_conf': num_noise_emails_per_conf
            },
            'difficulty': {
                'enable_reminders': enable_reminders,
                'enable_extensions': enable_extensions
            }
        }
        
        return {
            'emails': emails,
            'metadata': metadata
        }


def parse_arguments():
    """Parse command line arguments"""
    parser = ArgumentParser(
        description='Conference Deadline Email Generator',
        formatter_class=RawDescriptionHelpFormatter
    )

    # Basic configuration
    parser.add_argument('--num-target', type=int, default=1,
                        help='Number of conferences with target information, default: 1')
    parser.add_argument('--num-noise', type=int, default=2,
                        help='Number of noise conferences, default: 2')
    parser.add_argument('--noise-emails', type=int, default=2,
                        help='Number of emails per noise conference, default: 2')
    parser.add_argument('--max-conferences', type=int, default=200,
                        help='Maximum conference pool size, default: 200')
    parser.add_argument('--seed', type=int, default=42,
                        help='Random seed, default: 42')

    # Difficulty control
    parser.add_argument('--enable-reminders', action='store_true',
                        help='Enable reminder emails (increases email count)')
    parser.add_argument('--enable-extensions', action='store_true',
                        help='Enable deadline extensions (increases confusion)')
    parser.add_argument('--base-date', type=str, default='2025-09-15',
                        help='Base date (today), format: YYYY-MM-DD')
    parser.add_argument('--deadline-offset', type=int, default=15,
                        help='Days from base_date to deadline, default: 15')

    # Output configuration
    parser.add_argument('--output-dir', type=str, default='.',
                        help='Output directory, default: current directory')
    parser.add_argument('--receiver-email', type=str, default='rkelly27@mcp.com',
                        help='Receiver email, default: rkelly27@mcp.com')

    # Difficulty presets
    parser.add_argument('--difficulty', choices=['easy', 'medium', 'hard', 'expert'],
                        help='Difficulty preset level')
    
    return parser.parse_args()


def apply_difficulty_preset(args):
    """Apply difficulty preset"""
    if args.difficulty == 'easy':
        # Easy: 1 target conference, 1 noise conference, no additional complexity
        args.num_target = 1
        args.num_noise = 1
        args.noise_emails = 1
        args.enable_reminders = False
        args.enable_extensions = False
        
    elif args.difficulty == 'medium':
        # Medium: 1 target conference, 2-3 noise conferences, with reminder emails
        args.num_target = 1
        args.num_noise = 2
        args.noise_emails = 2
        args.enable_reminders = True
        args.enable_extensions = False
        
    elif args.difficulty == 'hard':
        # Hard: 1-2 target conferences, 3-4 noise conferences, with reminders and extensions
        args.num_target = random.randint(1, 2)
        args.num_noise = 3
        args.noise_emails = 3
        args.enable_reminders = True
        args.enable_extensions = True
        
    elif args.difficulty == 'expert':
        # Expert: multiple target conferences, lots of noise, all confusion factors
        args.num_target = random.randint(2, 3)
        args.num_noise = 4
        args.noise_emails = 4
        args.enable_reminders = True
        args.enable_extensions = True


def main():
    args = parse_arguments()

    # Apply difficulty preset
    if args.difficulty:
        apply_difficulty_preset(args)

    print("=" * 60)
    print("Conference Deadline Email Generator")
    print("=" * 60)
    print(f"Configuration:")
    print(f"  Conference pool size: {args.max_conferences}")
    print(f"  Target conferences: {args.num_target}")
    print(f"  Noise conferences: {args.num_noise}")
    print(f"  Noise emails/conference: {args.noise_emails}")
    print(f"  Enable reminders: {args.enable_reminders}")
    print(f"  Enable extensions: {args.enable_extensions}")
    print(f"  Base date: {args.base_date}")
    print(f"  Deadline offset: {args.deadline_offset} days")
    print(f"  Random seed: {args.seed}")
    print("=" * 60)

    # Parse base date
    base_date = datetime.strptime(args.base_date, '%Y-%m-%d')

    # Generate emails
    print(f"Initializing conference generator (generating {args.max_conferences} conferences)...")
    generator = ConferenceEmailGenerator(seed=args.seed, max_conferences=args.max_conferences)
    print(f"Conference pool generated: {len(generator.CONFERENCES)} conferences")
    result = generator.generate_emails(
        num_target_conferences=args.num_target,
        num_noise_conferences=args.num_noise,
        num_noise_emails_per_conf=args.noise_emails,
        enable_reminders=args.enable_reminders,
        enable_extensions=args.enable_extensions,
        base_date=base_date,
        target_deadline_offset=args.deadline_offset
    )
    
    # Set receiver email
    for email in result['emails']:
        email['to_addr'] = args.receiver_email

    # Save to file
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save email backup
    backup_file = output_dir / "files" / "emails_backup.json"
    backup_file.parent.mkdir(parents=True, exist_ok=True)
    
    with open(backup_file, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    
    print(f"\nSuccessfully generated {len(result['emails'])} emails")

    target_info = result['metadata'].get('target_info', {})
    target_conferences = target_info.get('conferences', [])

    if len(target_conferences) == 1:
        print(f"   Target conference: {target_conferences[0]['conference']}")
        print(f"   Deadline: {target_conferences[0]['deadline']}")
    else:
        print(f"   Target conference count: {len(target_conferences)}")
        for conf_info in target_conferences:
            print(f"      - {conf_info['conference']} ({conf_info['track']}): {conf_info['deadline']}")

    print(f"   Output file: {backup_file}")

    # Save groundtruth
    groundtruth_dir = output_dir / "groundtruth_workspace"
    groundtruth_dir.mkdir(parents=True, exist_ok=True)

    # Save today.txt
    today_file = groundtruth_dir / "today.txt"
    with open(today_file, 'w') as f:
        f.write(args.base_date)

    print(f"   Today file: {today_file}")

    # Save metadata for evaluation
    metadata_file = groundtruth_dir / "conference_metadata.json"
    with open(metadata_file, 'w', encoding='utf-8') as f:
        json.dump(result['metadata'], f, indent=2, ensure_ascii=False)

    print(f"   Metadata file: {metadata_file}")
    print("\nEmail generation completed!")


if __name__ == "__main__":
    main()

