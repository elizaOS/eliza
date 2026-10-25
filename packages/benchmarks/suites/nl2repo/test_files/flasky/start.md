## Introduction and Goals of the Flasky Project

Flasky is a social blogging application developed based on the Flask framework, offering core functions such as user registration, login, article posting, commenting, and following. The project adopts the MVC architecture, supports RESTful APIs, and includes complete test cases and documentation. The system implements modules such as user authentication, article management, comment system, following mechanism, and permission control, providing developers with a comprehensive reference for Flask application development. The core functions of the system include: user registration and login (supporting email verification and password reset), article posting and management (supporting Markdown format and rich text content), comment system (supporting comment posting, review, and management), following mechanism (supporting user following, unfollowing, and following list), permission control (role-based access control), and API interfaces (providing complete RESTful API services).

## Natural Language Instructions

Please create a Python project named Flasky to implement a social blogging application. The project should include the following functions:

1. User Authentication System: Implement functions such as user registration, login, email verification, and password reset. Support role-based permission control, including roles such as ordinary users and administrators. Email verification is required during user registration, and the "Remember Me" function is supported for login. Password reset is done by sending a reset link via email. Support the function of modifying the email address, and use the Gravatar service for user avatars.

2. Article Management System: Implement functions such as article posting, editing, deletion, and paginated display. Support Markdown format and rich text content, and provide article search and classification functions. Articles support HTML content rendering, article detail pages, and article editing permission control.

3. Comment System: Implement the commenting function for articles, supporting operations such as comment posting, management, and review. Comments support HTML content rendering, paginated display, and review function. Administrators can delete or hide inappropriate comments.

4. Following System: Implement the user following function, supporting operations such as following, unfollowing, and displaying the following list. Provide dynamic push for followers, support the display of the follower article stream, and implement the core functions of the social network. Support follower statistics and following relationship query.

5. Interface Design: Each functional module (user management, article management, comment management, following management) should have independent API interfaces, supporting RESTful design. Provide clear input and output formats, support JSON data exchange, and include complete error handling and status codes. Support API authentication and permission control.

6. Core File Requirements: The project must include a complete requirements.txt file, which should configure the project as an installable package (supporting pip install) and declare a complete list of dependencies (such as Flask==0.12.2, Flask-SQLAlchemy==2.2, Flask-Migrate==2.0.4, Flask-Login==0.4.0, etc., the actual core libraries used). The setup.py file should ensure that all core functional modules can work properly. At the same time, app/init.py should be provided as a unified API entry, importing and exporting User, Role, Post, Comment, create_app, db, fake, AnonymousUser, Permission, Follow, current_app, and the main import and export functions, and providing version information, so that users can access all main functions through simple "from flask import **" and "from app.models import **" statements.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.9.23

### Core Dependency Library Versions

```
alembic           0.9.3
bleach            2.0.0
blinker           1.4
certifi           2017.7.27.1
chardet           3.0.4
click             6.7
coverage          4.4.1
dominate          2.3.1
exceptiongroup    1.3.0
Faker             0.7.18
Flask             0.12.2
Flask-Bootstrap   3.3.7.1
Flask-HTTPAuth    3.2.3
Flask-Login       0.4.0
Flask-Mail        0.9.1
Flask-Migrate     2.0.4
Flask-Moment      0.5.1
Flask-PageDown    0.2.2
Flask-Script      2.0.6
Flask-SQLAlchemy  2.5.1
Flask-WTF         0.14.2
greenlet          3.2.4
html5lib          0.999999999
httpie            0.9.9
idna              2.5
iniconfig         2.1.0
itsdangerous      0.24
Jinja2            2.9.6
Mako              1.0.7
Markdown          2.6.8
MarkupSafe        1.1.1
packaging         25.0
pip               23.0.1
pluggy            1.6.0
Pygments          2.19.2
pytest            8.4.1
python-dateutil   2.6.1
python-dotenv     0.6.5
python-editor     1.0.3
requests          2.18.2
selenium          3.141.0
setuptools        58.1.0
six               1.10.0
SQLAlchemy        1.4.46
tomli             2.2.1
typing_extensions 4.14.1
urllib3           1.22
visitor           0.1.3
webencodings      0.5.1
Werkzeug          0.12.2
wheel             0.45.1
WTForms           2.1
```

## Flask Project Architecture

### Project Directory Structure

```
workspace/
├── .gitignore
├── Dockerfile
├── LICENSE
├── Procfile
├── README.md
├── app
│   ├── __init__.py
│   ├── api
│   │   ├── __init__.py
│   │   ├── authentication.py
│   │   ├── comments.py
│   │   ├── decorators.py
│   │   ├── errors.py
│   │   ├── posts.py
│   │   ├── users.py
│   ├── auth
│   │   ├── __init__.py
│   │   ├── forms.py
│   │   ├── views.py
│   ├── decorators.py
│   ├── email.py
│   ├── exceptions.py
│   ├── fake.py
│   ├── main
│   │   ├── __init__.py
│   │   ├── errors.py
│   │   ├── forms.py
│   │   ├── views.py
│   ├── models.py
│   ├── static
│   │   ├── favicon.ico
│   │   ├── styles.css
│   ├── templates
│   │   ├── 403.html
│   │   ├── 404.html
│   │   ├── 500.html
│   │   ├── _comments.html
│   │   ├── _macros.html
│   │   ├── _posts.html
│   │   ├── auth
│   │   │   ├── change_email.html
│   │   │   ├── change_password.html
│   │   │   ├── email
│   │   │   │   ├── change_email.html
│   │   │   │   ├── change_email.txt
│   │   │   │   ├── confirm.html
│   │   │   │   ├── confirm.txt
│   │   │   │   ├── reset_password.html
│   │   │   │   ├── reset_password.txt
│   │   │   ├── login.html
│   │   │   ├── register.html
│   │   │   ├── reset_password.html
│   │   │   ├── unconfirmed.html
│   │   ├── base.html
│   │   ├── edit_post.html
│   │   ├── edit_profile.html
│   │   ├── followers.html
│   │   ├── index.html
│   │   ├── mail
│   │   │   ├── new_user.html
│   │   │   ├── new_user.txt
│   │   ├── moderate.html
│   │   ├── post.html
│   │   └── user.html
├── boot.sh
├── config.py
├── docker-compose.yml
├── flasky.py
├── migrations
│   ├── README
│   ├── alembic.ini
│   ├── env.py
│   ├── script.py.mako
│   ├── versions
│   │   ├── 190163627111_account_confirmation.py
│   │   ├── 198b0eebcf9_caching_of_avatar_hashes.py
│   │   ├── 1b966e7f4b9e_post_model.py
│   │   ├── 2356a38169ea_followers.py
│   │   ├── 288cd3dc5a8_rich_text_posts.py
│   │   ├── 38c4e85512a9_initial_migration.py
│   │   ├── 456a945560f6_login_support.py
│   │   ├── 51f5ccfba190_comments.py
│   │   ├── 56ed7d33de8d_user_roles.py
│   │   └── d66f086b258_user_information.py
└── requirements.txt
```

## API Usage Guide

### Core APIs

#### 1. Module Import

```python
from flask import current_app
from app.models import User, Role, Post, Comment, create_app, db, fake, AnonymousUser, Permission, Follow
```

---

#### 2. Permission Class

**Class Description**: The Permission class is used to manage user permissions in the application. It is a subclass of the Role class and is used to manage user permissions.

**Class Definition**:
```python
class Permission:
    FOLLOW = 1
    COMMENT = 2
    WRITE = 4
    MODERATE = 8
    ADMIN = 16
```

#### 3. Role Class

**Class Description**: The Role class is used to manage user roles in the application. It is a subclass of the User class and is used to manage user roles.

**Class Definition**:
```python
class Role(db.Model):
    __tablename__ = 'roles'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(64), unique=True)
    default = db.Column(db.Boolean, default=False, index=True)
    permissions = db.Column(db.Integer)
    users = db.relationship('User', backref='role', lazy='dynamic')

    def __init__(self, **kwargs):
        super(Role, self).__init__(**kwargs)
        if self.permissions is None:
            self.permissions = 0

    @staticmethod
    def insert_roles():
        """Insert roles into the database.
        The roles are:
        - User: Ordinary users, with the right to follow, comment, and write articles.
        - Moderator: Moderators, with the right to follow, comment, write articles, and moderate comments.
        - Administrator: Administrators, with the right to follow, comment, write articles, moderate comments, and administer the system.
        """

    def add_permission(self, perm):
        """Add a permission to the role.
        Args:
            perm: The permission to add.
        """

    def remove_permission(self, perm):
        """Remove a permission from the role.
        Args:
            perm: The permission to remove.
        """

    def reset_permissions(self):
        """Reset the permissions of the role."""

    def has_permission(self, perm):
        """Check if the role has the permission.
        Args:
            perm: The permission to check.
        """

    def __repr__(self):
        return '<Role %r>' % self.name
```

#### 4. Follow Class

**Class Description**: The Follow class is used to manage the following relationship between users. It is a subclass of the User class and is used to manage the following relationship between users.

**Class Definition**:
```python
class Follow(db.Model):
    __tablename__ = 'follows'
    follower_id = db.Column(db.Integer, db.ForeignKey('users.id'),
                            primary_key=True)
    followed_id = db.Column(db.Integer, db.ForeignKey('users.id'),
                            primary_key=True)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
```

#### 5. User Class

**Class Description**: The User class is used to manage the user in the application. It is a subclass of the UserMixin class and is used to manage the user in the application.

**Class Definition**:
```python
class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(64), unique=True, index=True)
    username = db.Column(db.String(64), unique=True, index=True)
    role_id = db.Column(db.Integer, db.ForeignKey('roles.id'))
    password_hash = db.Column(db.String(128))
    confirmed = db.Column(db.Boolean, default=False)
    name = db.Column(db.String(64))
    location = db.Column(db.String(64))
    about_me = db.Column(db.Text())
    member_since = db.Column(db.DateTime(), default=datetime.utcnow)
    last_seen = db.Column(db.DateTime(), default=datetime.utcnow)
    avatar_hash = db.Column(db.String(32))
    posts = db.relationship('Post', backref='author', lazy='dynamic')
    followed = db.relationship('Follow',
                               foreign_keys=[Follow.follower_id],
                               backref=db.backref('follower', lazy='joined'),
                               lazy='dynamic',
                               cascade='all, delete-orphan')
    followers = db.relationship('Follow',
                                foreign_keys=[Follow.followed_id],
                                backref=db.backref('followed', lazy='joined'),
                                lazy='dynamic',
                                cascade='all, delete-orphan')
    comments = db.relationship('Comment', backref='author', lazy='dynamic')

    @staticmethod
    def add_self_follows():
        """Add self follows to the user."""

    def __init__(self, **kwargs):
        super(User, self).__init__(**kwargs)
        if self.role is None:
            if self.email == current_app.config['FLASKY_ADMIN']:
                self.role = Role.query.filter_by(name='Administrator').first()
            if self.role is None:
                self.role = Role.query.filter_by(default=True).first()
        if self.email is not None and self.avatar_hash is None:
            self.avatar_hash = self.gravatar_hash()
        self.follow(self)

    @property
    def password(self):
        raise AttributeError('password is not a readable attribute')

    @password.setter
    def password(self, password):
        self.password_hash = generate_password_hash(password)

    def verify_password(self, password):
        return check_password_hash(self.password_hash, password)

    def generate_confirmation_token(self, expiration=3600):
        s = Serializer(current_app.config['SECRET_KEY'], expiration)
        return s.dumps({'confirm': self.id}).decode('utf-8')

    def confirm(self, token):
        """Confirm the user.
        Args:
            token: The token to confirm the user.
        Returns:
            True if the user is confirmed, False otherwise.
        """
        return False

    def generate_reset_token(self, expiration=3600):
        """Generate a reset token for the user.
        Args:
            expiration: The expiration time of the token.
        Returns:
            The reset token.
        """

    @staticmethod
    def reset_password(token, new_password):
        """Reset the password for the user.
        Args:
            token: The token to reset the password.
            new_password: The new password.
        Returns:
            True if the password is reset, False otherwise.
        """
        return False

    def generate_email_change_token(self, new_email, expiration=3600):
        """Generate an email change token for the user.
        Args:
            new_email: The new email.
            expiration: The expiration time of the token.
        Returns:
            The email change token.
        """
        return False
    def change_email(self, token):
        """Change the email for the user.
        Args:
            token: The token to change the email.
        Returns:
            True if the email is changed, False otherwise.
        """

    def can(self, perm):
        return self.role is not None and self.role.has_permission(perm)

    def is_administrator(self):
        return self.can(Permission.ADMIN)

    def ping(self):
        self.last_seen = datetime.utcnow()
        db.session.add(self)

    def gravatar_hash(self):
        return hashlib.md5(self.email.lower().encode('utf-8')).hexdigest()

    def gravatar(self, size=100, default='identicon', rating='g'):
        """Generate a gravatar for the user.
        Args:
            size: The size of the gravatar.
            default: The default gravatar.
            rating: The rating of the gravatar.
        Returns:
            The gravatar.
        """
        url = 'https://secure.gravatar.com/avatar'

    def follow(self, user):
        """Follow a user.
        Args:
            user: The user to follow.
        """

    def unfollow(self, user):
        """Unfollow a user.
        Args:
            user: The user to unfollow.
        """

    def is_following(self, user):
        """Check if the user is following another user.
        Args:
            user: The user to check.
        Returns:
            True if the user is following another user, False otherwise.
        """

    def is_followed_by(self, user):
        """Check if the user is followed by another user.
        Args:
            user: The user to check.
        Returns:
            True if the user is followed by another user, False otherwise.
        """

    @property
    def followed_posts(self):
        """Get the posts followed by the user.
        Returns:
            The posts followed by the user.
        """

    def to_json(self):
        """Convert the user to a JSON object.
        Returns:
            The JSON object.
        """

    def generate_auth_token(self, expiration):
        """Generate an authentication token for the user.
        Args:
            expiration: The expiration time of the token.
        Returns:
            The authentication token.
        """

    @staticmethod
    def verify_auth_token(token):
        """Verify an authentication token for the user.
        Args:
            token: The token to verify.
        Returns:
            The user if the token is valid, None otherwise.
        """

    def __repr__(self):
        return '<User %r>' % self.username
```

#### 6. AnonymousUser Class

**Class Description**: The AnonymousUser class is used to manage the anonymous user in the application. It is a subclass of the AnonymousUserMixin class and is used to manage the anonymous user in the application.

**Class Definition**:
```python
class AnonymousUser(AnonymousUserMixin):
    def can(self, permissions):
        return False

    def is_administrator(self):
        return False

login_manager.anonymous_user = AnonymousUser


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))
```

#### 7. Post Class

**Class Description**: The Post class is used to manage the post in the application. It is a subclass of the db.Model class and is used to manage the post in the application.

**Class Definition**:
```python
class Post(db.Model):
    __tablename__ = 'posts'
    id = db.Column(db.Integer, primary_key=True)
    body = db.Column(db.Text)
    body_html = db.Column(db.Text)
    timestamp = db.Column(db.DateTime, index=True, default=datetime.utcnow)
    author_id = db.Column(db.Integer, db.ForeignKey('users.id'))
    comments = db.relationship('Comment', backref='post', lazy='dynamic')

    @staticmethod
    def on_changed_body(target, value, oldvalue, initiator):
        """On changed body.
        Args:
            target: The target to change.
            value: The value to change.
            oldvalue: The old value.
            initiator: The initiator.
        Returns:
            The body HTML.
        """
        allowed_tags = ['a', 'abbr', 'acronym', 'b', 'blockquote', 'code',
                        'em', 'i', 'li', 'ol', 'pre', 'strong', 'ul',
                        'h1', 'h2', 'h3', 'p'].

    def to_json(self):
        """Convert the post to a JSON object.
        Returns:
            The JSON object.
        """

    @staticmethod
    def from_json(json_post):
        """From JSON post.
        Args:
            json_post: The JSON post.
        Returns:
            The post.
        """

```

#### 8. Comment Class

**Class Description**: The Comment class is used to manage the comment in the application. It is a subclass of the db.Model class and is used to manage the comment in the application.

**Class Definition**:
```python
class Comment(db.Model):
    __tablename__ = 'comments'
    id = db.Column(db.Integer, primary_key=True)
    body = db.Column(db.Text)
    body_html = db.Column(db.Text)
    timestamp = db.Column(db.DateTime, index=True, default=datetime.utcnow)
    disabled = db.Column(db.Boolean)
    author_id = db.Column(db.Integer, db.ForeignKey('users.id'))
    post_id = db.Column(db.Integer, db.ForeignKey('posts.id'))

    @staticmethod
    def on_changed_body(target, value, oldvalue, initiator):
        """On changed body.
        Args:
            target: The target to change.
            value: The value to change.
            oldvalue: The old value.
            initiator: The initiator.
        Returns:
            The body HTML.
        """

    def to_json(self):
        """Convert the comment to a JSON object.
        Returns:
            The JSON object.
        """

    @staticmethod
    def from_json(json_comment):
        """From JSON comment.
        Args:
            json_comment: The JSON comment.
        Returns:
            The comment.
        """

```

#### 9. RegistrationForm Class

**Class Description**: The RegistrationForm class is used to manage the registration form in the application. It is a subclass of the FlaskForm class and is used to manage the registration form in the application.

**Class Definition**:
```python
class LoginForm(FlaskForm):
    email = StringField('Email', validators=[DataRequired(), Length(1, 64),
                                             Email()])
    password = PasswordField('Password', validators=[DataRequired()])
    remember_me = BooleanField('Keep me logged in')
    submit = SubmitField('Log In')
```

#### 10. ChangePasswordForm Class

**Class Description**: The ChangePasswordForm class is used to manage the change password form in the application. It is a subclass of the FlaskForm class and is used to manage the change password form in the application.

**Class Definition**:
```python
class ChangePasswordForm(FlaskForm):
    old_password = PasswordField('Old password', validators=[DataRequired()])
    password = PasswordField('New password', validators=[
```

#### 11. RegistrationForm Class

**Class Description**: The RegistrationForm class is used to manage the registration form in the application. It is a subclass of the FlaskForm class and is used to manage the registration form in the application.

**Class Definition**:
```python
class RegistrationForm(FlaskForm):
    email = StringField('Email', validators=[DataRequired(), Length(1, 64),
                                             Email()])
    username = StringField('Username', validators=[
        DataRequired(), Length(1, 64),
        Regexp('^[A-Za-z][A-Za-z0-9_.]*$', 0,
               'Usernames must have only letters, numbers, dots or '
               'underscores')])
    password = PasswordField('Password', validators=[
        DataRequired(), EqualTo('password2', message='Passwords must match.')])
    password2 = PasswordField('Confirm password', validators=[DataRequired()])
    submit = SubmitField('Register')

    def validate_email(self, field):
        """Validate the email.
        Args:
            field: The field to validate.
        Returns:
            True if the email is valid, False otherwise.
        """

    def validate_username(self, field):
        """Validate the username.
        Args:
            field: The field to validate.
        Returns:
            True if the username is valid, False otherwise.
        """
```

#### 12. ChangePasswordForm Class

**Class Description**: The ChangePasswordForm class is used to manage the change password form in the application. It is a subclass of the FlaskForm class and is used to manage the change password form in the application.

**Class Definition**:
```python
class ChangePasswordForm(FlaskForm):
    old_password = PasswordField('Old password', validators=[DataRequired()])
    password = PasswordField('New password', validators=[
        DataRequired(), EqualTo('password2', message='Passwords must match.')])
    password2 = PasswordField('Confirm new password',
                              validators=[DataRequired()])
    submit = SubmitField('Update Password')
```

#### 13. PasswordResetRequestForm Class

**Class Description**: The PasswordResetRequestForm class is used to manage the password reset request form in the application. It is a subclass of the FlaskForm class and is used to manage the password reset request form in the application.

**Class Definition**:
```python
class PasswordResetRequestForm(FlaskForm):
    email = StringField('Email', validators=[DataRequired(), Length(1, 64),
                                             Email()])
    submit = SubmitField('Reset Password')
```

#### 14. PasswordResetForm Class

**Class Description**: The PasswordResetForm class is used to manage the password reset form in the application. It is a subclass of the FlaskForm class and is used to manage the password reset form in the application.

**Class Definition**:
```python
class PasswordResetForm(FlaskForm):
    password = PasswordField('New Password', validators=[
        DataRequired(), EqualTo('password2', message='Passwords must match')])
    password2 = PasswordField('Confirm password', validators=[DataRequired()])
    submit = SubmitField('Reset Password')
```

#### 15. ChangeEmailForm Class

**Class Description**: The ChangeEmailForm class is used to manage the change email form in the application. It is a subclass of the FlaskForm class and is used to manage the change email form in the application.

**Class Definition**:
```python
class ChangeEmailForm(FlaskForm):
    email = StringField('New Email', validators=[DataRequired(), Length(1, 64),
                                                 Email()])
    password = PasswordField('Password', validators=[DataRequired()])
    submit = SubmitField('Update Email Address')

    def validate_email(self, field):
        if User.query.filter_by(email=field.data.lower()).first():
            raise ValidationError('Email already registered.')
```

#### 16. PostForm Class

**Class Description**: The PostForm class is used to manage the post form in the application. It is a subclass of the FlaskForm class and is used to manage the post form in the application.

**Class Definition**:
```python
class PostForm(FlaskForm):
    body = PageDownField("What's on your mind?", validators=[DataRequired()])
    submit = SubmitField('Submit')
```

#### 17. NameForm Class

**Class Description**: The NameForm class is used to manage the name form in the application. It is a subclass of the FlaskForm class and is used to manage the name form in the application.

**Class Definition**:
```python
class NameForm(FlaskForm):
    name = StringField('What is your name?', validators=[DataRequired()])
    submit = SubmitField('Submit')
```

#### 18. EditProfileForm Class

**Class Description**: The EditProfileForm class is used to manage the edit profile form in the application. It is a subclass of the FlaskForm class and is used to manage the edit profile form in the application.

**Class Definition**:
```python
class EditProfileForm(FlaskForm):
    name = StringField('Real name', validators=[Length(0, 64)])
    location = StringField('Location', validators=[Length(0, 64)])
    about_me = TextAreaField('About me')
    submit = SubmitField('Submit')
```

#### 19. EditProfileAdminForm Class

**Class Description**: The EditProfileAdminForm class is used to manage the edit profile admin form in the application. It is a subclass of the FlaskForm class and is used to manage the edit profile admin form in the application.

**Class Definition**:
```python
class EditProfileAdminForm(FlaskForm):
    email = StringField('Email', validators=[DataRequired(), Length(1, 64),
                                             Email()])
    username = StringField('Username', validators=[
        DataRequired(), Length(1, 64),
        Regexp('^[A-Za-z][A-Za-z0-9_.]*$', 0,
               'Usernames must have only letters, numbers, dots or '
               'underscores')])
    confirmed = BooleanField('Confirmed')
    role = SelectField('Role', coerce=int)
    name = StringField('Real name', validators=[Length(0, 64)])
    location = StringField('Location', validators=[Length(0, 64)])
    about_me = TextAreaField('About me')
    submit = SubmitField('Submit')

    def __init__(self, user, *args, **kwargs):
        super(EditProfileAdminForm, self).__init__(*args, **kwargs)
        self.role.choices = [(role.id, role.name)
                             for role in Role.query.order_by(Role.name).all()]
        self.user = user

    def validate_email(self, field):
        """Validate the email.
        Args:
            field: The field to validate.
        """

    def validate_username(self, field):
        """Validate the username.
        Args:
            field: The field to validate.
        """
```

#### 20. CommentForm Class

**Class Description**: The CommentForm class is used to manage the comment form in the application. It is a subclass of the FlaskForm class and is used to manage the comment form in the application.

**Class Definition**:
```python
class CommentForm(FlaskForm):
    body = StringField('Enter your comment', validators=[DataRequired()])
    submit = SubmitField('Submit')
```

#### 21. send_async_email() Function

**Function**: The send_async_email function is used to send an email asynchronously in the application.

**Function Signature**:
```python
def send_async_email(app, msg):
```

**Parameters**:
app: The application instance.
msg: The message to send.

**Returns**:
The thread object.

#### 22. send_email() Function

**Function**: The send_email function is used to send an email in the application.

**Function Signature**:
```python
def send_email(to, subject, template, **kwargs):
```

**Parameters**:
to: The recipient of the email.
subject: The subject of the email.
template: The template of the email.
kwargs: The keyword arguments.

**Returns**:
The thread object.

#### 23. permission_required() Function

**Function**: The permission_required function is used to check if the user has the required permission to access the resource.
**Function Signature**:
```python
# In app/decorators.py
def permission_required(permission):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
```

**Parameters**:
permission: The permission to check.

**Returns**:
The decorator function.

#### 24. admin_required() Function

**Function**: The admin_required function is used to check if the user is an administrator.

**Function Signature**:
```python
def admin_required(f):
```

**Parameters**:
f: The function to check.

**Returns**:
The decorator function.

#### 25. permission_required() Function

**Function**: The permission_required function is used to check if the user has the required permission to access the resource.

**Function Signature**:
```python
# In app/api/decorators.py
def permission_required(permission):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
```

**Parameters**:
permission: The permission to check.

**Returns**:
The decorator function.

#### 26. before_request() Function

**Function**: The before_request function is used to check if the user is authenticated and confirmed.
**Function Signature**:
```python
# In app/api/authentication.py
@api.before_request
@auth.login_required
def before_request():
```

**Parameters**:
None

**Returns**:
forbidden('Unconfirmed account')

#### 27. before_request() Function

**Function**: The before_request function is used to check if the user is authenticated and confirmed.

**Function Signature**:
```python
# In app/auth/views.py
@auth.before_app_request
def before_request():
    if current_user.is_authenticated:
        current_user.ping()
        if not current_user.confirmed \
                and request.endpoint \
                and request.blueprint != 'auth' \
                and request.endpoint != 'static':
            return 
```

**Parameters**: None

**Returns**:
redirect(url_for('auth.unconfirmed'))

#### 28. verify_password() Function

**Function**: The verify_password function is used to verify the password of the user.

**Function Signature**:
```python
# In app/api/authentication.py
@auth.verify_password
def verify_password(email_or_token, password):
```

**Parameters**:
email_or_token: The email or token to verify.
password: The password to verify.

**Returns**:
True if the password is verified, False otherwise.

#### 29. auth_error() Function

**Function**: The auth_error function is used to handle the error of the authentication.

**Function Signature**:
```python
# In app/api/authentication.py
@auth.error_handler
def auth_error():
```

**Parameters**: None

**Returns**:
unauthorized('Invalid credentials')

#### 30. get_token() Function

**Function**: The get_token function is used to get the token of the user.

**Function Signature**:
```python
# In app/api/authentication.py
@api.route('/tokens/', methods=['POST'])
def get_token():
```

**Parameters**: None

**Returns**:
jsonify({'token': g.current_user.generate_auth_token(
        expiration=3600), 'expiration': 3600})

#### 31. logout() Function

**Function**: The logout function is used to logout the user.

**Function Signature**:
```python
# In app/auth/views.py
@auth.route('/logout')
@login_required
def logout():
```

**Parameters**: None

**Returns**:
redirect(url_for('main.index'))

#### 32. unconfirmed() Function

**Function**: The unconfirmed function is used to handle the unconfirmed user.

**Function Signature**:
```python
# In app/auth/views.py
@auth.route('/unconfirmed')
def unconfirmed():
```

**Parameters**: None

**Returns**:
render_template('auth/unconfirmed.html')

#### 33. login() Function

**Function**: The login function is used to login the user.

**Function Signature**:
```python
# In app/auth/views.py
@auth.route('/login', methods=['GET', 'POST'])
def login():
```

**Parameters**: None

**Returns**:
redirect(url_for('main.index'))

#### 34. register() Function

**Function**: The register function is used to register the user.

**Function Signature**:
```python
# In app/auth/views.py
@auth.route('/register', methods=['GET', 'POST'])
def register():
```

**Parameters**: None

**Returns**:
redirect(url_for('auth.login'))

#### 35. confirm() Function

**Function**: The confirm function is used to confirm the user.

**Function Signature**:
```python
# In app/auth/views.py
@auth.route('/confirm/<token>')
@login_required
def confirm(token):
```

**Parameters**: 
token: The token to confirm the user.

**Returns**:
redirect(url_for('main.index'))

#### 36. resend_confirmation() Function

**Function**: The resend_confirmation function is used to resend the confirmation email to the user.

**Function Signature**:
```python
# In app/auth/views.py
@auth.route('/confirm')
@login_required
def resend_confirmation():
```

**Parameters**: None

**Returns**:
redirect(url_for('main.index'))

#### 37. change_password() Function

**Function**: The change_password function is used to change the password of the user.

**Function Signature**:
```python
# In app/auth/views.py
@auth.route('/change-password', methods=['GET', 'POST'])
@login_required
def change_password():
```

**Parameters**: None

**Returns**:
if form.validate_on_submit(): redirect(url_for('main.index')) else render_template("auth/change_password.html", form=form)

#### 38. password_reset_request() Function

**Function**: The password_reset_request function is used to reset the password of the user.

**Function Signature**:
```python
# In app/auth/views.py
@auth.route('/reset', methods=['GET', 'POST'])
def password_reset_request():
```

**Parameters**: None

**Returns**:
if form.validate_on_submit(): redirect(url_for('auth.login')) else render_template('auth/reset_password.html', form=form)

#### 39. password_reset() Function

**Function**: The password_reset function is used to reset the password of the user.

**Function Signature**:
```python
# In app/auth/views.py
@auth.route('/reset/<token>', methods=['GET', 'POST'])
def password_reset(token):
```

**Parameters**: 
token: The token to reset the password.

**Returns**:
if form.validate_on_submit(): redirect(url_for('auth.login')) else render_template('auth/reset_password.html', form=form)

#### 40. change_email_request() Function

**Function**: The change_email_request function is used to change the email of the user.

**Function Signature**:
```python
# In app/auth/views.py
@auth.route('/change_email', methods=['GET', 'POST'])
@login_required
def change_email_request():
```

**Parameters**: None

**Returns**:
if form.validate_on_submit(): redirect(url_for('main.index')) else render_template("auth/change_email.html", form=form)

#### 41. change_email() Function

**Function**: The change_email function is used to change the email of the user.

**Function Signature**:
```python
# In app/auth/views.py
@auth.route('/change_email/<token>')
@login_required
def change_email(token):
```

**Parameters**: 
token: The token to change the email.

**Returns**:
redirect(url_for('main.index'))

#### 42. get_user() Function

**Function**: The get_user_posts function is used to get the posts of the user.

**Function Signature**:
```python
# In app/api/users.py
@api.route('/users/<int:id>')
def get_user(id):
```

**Parameters**: 
id: The id of the user.

**Returns**:
jsonify(user.to_json())

#### 43. get_user_posts() Function

**Function**: The get_user_posts function is used to get the posts of the user.

**Function Signature**:
```python
# In app/api/users.py
@api.route('/users/<int:id>/posts/')
def get_user_posts(id):
```

**Parameters**: 
id: The id of the user.

**Returns**:
jsonify({
    'posts': [post.to_json() for post in posts],
    'prev': prev,
    'next': next,
    'count': pagination.total
})

#### 44. get_user_followed_posts() Function

**Function**: The get_user_followed_posts function is used to get the followed posts of the user.

**Function Signature**:
```python
@api.route('/users/<int:id>/timeline/')
def get_user_followed_posts(id):
```

**Parameters**: 
id: The id of the user.

**Returns**:
jsonify({
    'posts': [post.to_json() for post in posts],
    'prev': prev,
    'next': next,
    'count': pagination.total
})

#### 45. get_posts() Function

**Function**: The get_posts function is used to get the posts of the user.

**Function Signature**:
```python
# In app/api/posts.py
@api.route('/posts/')
def get_posts():
```

**Parameters**: None

**Returns**:
jsonify({
        'posts': [post.to_json() for post in posts],
        'prev': prev,
        'next': next,
        'count': pagination.total
    })

#### 46. get_post() Function

**Function**: The get_post function is used to get the post of the user.

**Function Signature**:
```python
# In app/api/posts.py

@api.route('/posts/<int:id>')
def get_post(id):
```

**Parameters**: 
id: The id of the user.

**Returns**:
jsonify(post.to_json())

#### 47. new_post() Function

**Function**: The new_post function is used to create a new post.

**Function Signature**:
```python
# In app/api/posts.py
@api.route('/posts/', methods=['POST'])
@permission_required(Permission.WRITE)
def new_post():
```

**Parameters**: None

**Returns**:
jsonify(post.to_json()), 201, {'Location': url_for('api.get_post', id=post.id)}

#### 48. edit_post() Function

**Function**: The edit_post function is used to edit the post of the user.

**Function Signature**:
```python
# In app/api/posts.py
@api.route('/posts/<int:id>', methods=['PUT'])
@permission_required(Permission.WRITE)
def edit_post(id):
```

**Parameters**: 
id: The id of the user.

**Returns**:
jsonify(post.to_json())

#### 49. bad_request() Function

**Function**: The bad_request function is used to return a bad request error.

**Function Signature**:
```python
# In app/api/errors.py
def bad_request(message):
```

**Parameters**: 
message: The message to return.

**Returns**:
response

#### 50. unauthorized() Function

**Function**: The unauthorized function is used to return a unauthorized error.

**Function Signature**:
```python
# In app/api/errors.py
def unauthorized(message):
```

**Parameters**: 
message: The message to return.

**Returns**:
response

**Function Signature**:
```python
# In app/api/errors.py
def forbidden(message):
```

**Parameters**: 
message: The message to return.

**Returns**:
response

**Function Signature**:
```python
# In app/api/errors.py
@api.errorhandler(ValidationError)
def validation_error(e):
```

**Parameters**: 
e: The error to return.

**Returns**:
bad_request(e.args[0])

#### 51. get_comments() Function

**Function**: The get_comments function is used to get the comments of the user.

**Function Signature**:
```python
# In app/api/comments.py
@api.route('/comments/')
def get_comments():
```

**Parameters**: None

**Returns**:
jsonify({
    'comments': [comment.to_json() for comment in comments],
    'prev': prev,
    'next': next,
    'count': pagination.total
})

#### 52. get_comment() Function

**Function**: The get_comment function is used to get the comment of the user.

**Function Signature**:
```python
# In app/api/comments.py
@api.route('/comments/<int:id>')
def get_comment(id):
```

**Parameters**: 
id: The id of the user.

**Returns**:
jsonify(comment.to_json())

#### 53. get_post_comments() Function

**Function**: The get_post_comments function is used to get the comments of the post.

**Function Signature**:
```python
# In app/api/comments.py
@api.route('/posts/<int:id>/comments/')
def get_post_comments(id):
```
**Parameters**: 
id: The id of the post.

**Returns**:
jsonify({
    'comments': [comment.to_json() for comment in comments],
    'prev': prev,
    'next': next,
    'count': pagination.total
})


#### 54. new_post_comment() Function

**Function**: The new_post_comment function is used to create a new comment.

**Function Signature**:
```python
# In app/api/comments.py
@api.route('/posts/<int:id>/comments/', methods=['POST'])
@permission_required(Permission.COMMENT)
def new_post_comment(id):
```

**Parameters**: 
id: The id of the post.

**Returns**:
jsonify(comment.to_json()), 201, {'Location': url_for('api.get_comment', id=comment.id)}

#### 55. inject_permissions() Function

**Function**: The inject_permissions function is used to inject the permissions into the template.

**Function Signature**:
```python
# In app/main/__init__.py
@main.app_context_processor
def inject_permissions():
```

**Parameters**: None

**Returns**:
dict(Permission=Permission)

#### 56. forbidden() Function

**Function**: The forbidden function is used to return a forbidden error.

**Function Signature**:
```python
# In app/main/errors.py
@main.app_errorhandler(403)
def forbidden(e):
```

**Parameters**: 
e: The error to return.

**Returns**:
if request.accept_mimetypes.accept_json and \
            not request.accept_mimetypes.accept_html: response else: render_template('403.html'), 403

#### 57. page_not_found() Function

**Function**: The page_not_found function is used to return a page not found error.

**Function Signature**:
```python
# In app/main/errors.py
def page_not_found(e):
```

**Parameters**: 
e: The error to return.

**Returns**:
if request.accept_mimetypes.accept_json and \
            not request.accept_mimetypes.accept_html: response else: render_template('404.html'), 404

#### 58. internal_server_error() Function

**Function**: The internal_server_error function is used to return a internal server error.

**Function Signature**:
```python
# In app/main/errors.py
@main.app_errorhandler(500)
def internal_server_error(e):
```

**Parameters**: 
e: The error to return.

**Returns**:
if request.accept_mimetypes.accept_json and \
            not request.accept_mimetypes.accept_html: response else: render_template('500.html'), 500

#### 59. after_request() Function

**Function**: The after_request function is used to return a after request.

**Function Signature**:
```python
# In app/main/views.py
@main.after_app_request
def after_request(response):
```

**Parameters**: 
response: The response to return.

**Returns**:
for query in get_debug_queries(): if query.duration >= current_app.config['FLASKY_SLOW_DB_QUERY_TIME']: current_app.logger.warning('Slow query: %s\nParameters: %s\nDuration: %fs\nContext: %s\n' % (query.statement, query.parameters, query.duration, query.context)) return response

#### 60. server_shutdown() Function

**Function**: The server_shutdown function is used to return a server shutdown.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/shutdown')
def server_shutdown():
```

**Parameters**: None

**Returns**:
if not current_app.testing: abort(404) shutdown = request.environ.get('werkzeug.server.shutdown') if not shutdown: abort(500) shutdown() return 'Shutting down...'

#### 61. index() Function

**Function**: The index function is used to return a index.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/', methods=['GET', 'POST'])
def index():
```

**Parameters**: None

**Returns**:
if current_user.can(Permission.WRITE) and form.validate_on_submit(): redirect(url_for('.index'))
else:render_template('index.html', form=form, posts=posts, show_followed=show_followed, pagination=pagination)

#### 62. user() Function

**Function**: The user function is used to return a user.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/user/<username>')
def user(username):
```

**Parameters**: 
username: The username of the user.

**Returns**:
render_template('user.html', user=user, posts=posts, pagination=pagination)

#### 63. edit_profile() Function

**Function**: The edit_profile function is used to return a edit_profile.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/edit-profile', methods=['GET', 'POST'])
@login_required
def edit_profile():
```

**Parameters**: None

**Returns**:
render_template('edit_profile.html', form=form)

#### 64. edit_profile_admin() Function

**Function**: The edit_profile_admin function is used to return a edit_profile_admin.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/edit-profile/<int:id>', methods=['GET', 'POST'])
@login_required
@admin_required
def edit_profile_admin(id):
```

**Parameters**: 
id: The id of the user.

**Returns**:
render_template('edit_profile.html', form=form, user=user)

#### 65. post() Function

**Function**: The post function is used to return a post.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/post/<int:id>', methods=['GET', 'POST'])
def post(id):
```

**Parameters**: 
id: The id of the post.

**Returns**:
if form.validate_on_submit(): redirect(url_for('.post', id=post.id, page=-1))
else: render_template('post.html', posts=[post], form=form, comments=comments, pagination=pagination)

#### 66. edit() Function

**Function**: The edit function is used to return a edit.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/edit/<int:id>', methods=['GET', 'POST'])
@login_required
def edit(id):
```

**Parameters**: 
id: The id of the post.

**Returns**:
if form.validate_on_submit(): redirect(url_for('.post', id=post.id)) else: render_template('edit_post.html', form=form)

#### 67. follow() Function

**Function**: The follow function is used to return a follow.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/follow/<username>')
@login_required
@permission_required(Permission.FOLLOW)
def follow(username):
```

**Parameters**: 
username: The username of the user.

**Returns**:
if user is None: redirect(url_for('.index')) 
if current_user.is_following(user): redirect(url_for('.user', username=username)) 
else: redirect(url_for('.user', username=username))

#### 68. unfollow() Function

**Function**: The unfollow function is used to return a unfollow.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/unfollow/<username>')
@login_required
@permission_required(Permission.FOLLOW)
def unfollow(username):
```

**Parameters**: 
username: The username of the user.

**Returns**:
if user is None: redirect(url_for('.index')) 
if not current_user.is_following(user): redirect(url_for('.user', username=username))
else: redirect(url_for('.user', username=username))

#### 69. followers() Function

**Function**: The followers function is used to return a followers.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/followers/<username>')
def followers(username):
```

**Parameters**: 
username: The username of the user.

**Returns**:
if user is None: redirect(url_for('.index')) 
else: render_template('followers.html', user=user, title="Followers of", endpoint='.followers', pagination=pagination, follows=follows)

#### 70. followed_by() Function

**Function**: The followed_by function is used to return a followed_by.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/followed_by/<username>')
def followed_by(username):
```

**Parameters**: 
username: The username of the user.

**Returns**:
if user is None: redirect(url_for('.index')) 
else: render_template('followers.html', user=user, title="Followed by", endpoint='.followed_by', pagination=pagination, follows=follows)

#### 71. show_all() Function

**Function**: The show_all function is used to return a show_all.
@main.route('/all')
@login_required
def show_all():
    resp = make_response(redirect(url_for('.index')))
    resp.set_cookie('show_followed', '', max_age=30*24*60*60)
    return resp

#### 72. show_followed() Function

**Function**: The show_followed function is used to return a show_followed.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/followed')
@login_required
def show_followed():```
```

**Parameters**: None

**Returns**:
resp: The response to return.

#### 73. moderate() Function

**Function**: The moderate function is used to return a moderate.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/moderate')
@login_required
@permission_required(Permission.MODERATE)
def moderate():
```

**Parameters**: None

**Returns**:
render_template('moderate.html', comments=comments, pagination=pagination, page=page)

#### 74. moderate_enable() Function

**Function**: The moderate_enable function is used to return a moderate_enable.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/moderate/enable/<int:id>')
@login_required
@permission_required(Permission.MODERATE)
def moderate_enable(id):
```

**Parameters**: 
id: The id of the comment.

**Returns**:
redirect(url_for('.moderate', page=request.args.get('page', 1, type=int)))

#### 75. moderate_disable() Function

**Function**: The moderate_disable function is used to return a moderate_disable.

**Function Signature**:
```python
# In app/main/views.py
@main.route('/moderate/disable/<int:id>')
@login_required
@permission_required(Permission.MODERATE)
def moderate_disable(id):
```

**Parameters**: 
id: The id of the comment.

**Returns**:
redirect(url_for('.moderate', page=request.args.get('page', 1, type=int)))

#### Example Usage

#### User Authentication
```python
from your_project.models import User

user = User(username='john', email='john@example.com')
user.set_password('secret')
```

#### Article Posting
```python
from your_project.models import Post

post = Post(body='This is a new post', author=user)
```

#### Comment Posting
```python
from your_project.models import Comment

comment = Comment(body='This is a comment', post=post, author=user)
```

#### Following a User
```python
from your_project.models import Follow

follow = Follow(follower=user, followed=another_user)
```

---

#### Notes
1. **User Authentication**: Ensure to use a strong password policy in the production environment.
2. **Articles and Comments**: Support Markdown format and rich text content.
3. **Following Function**: Users can follow other users and see the dynamics of followed users on the homepage.
4. **Permission Control**: Role-based permission control ensures that users can only perform operations allowed by their roles.

---

## Detailed Function Implementation Nodes

### Node 1: User Authentication System

**Function Description**: Implement core authentication functions such as user registration, login, password reset, and email verification, and support role-based permission control.

**Core Algorithms**:
- User registration process
- Password encryption storage
- Email confirmation mechanism
- Password reset function
- Login status management

**Input and Output Example**:
```python
from app.models import User
from app.auth.forms import RegistrationForm
from app import db

# User registration
form = RegistrationForm()
form.email.data = "user@example.com"
form.username.data = "testuser"
form.password.data = "password123"
user = User(email=form.email.data, username=form.username.data)
user.password = form.password.data
db.session.add(user)
db.session.commit()
print(user.id) # 1

# User login verification
user = User.query.filter_by(email="user@example.com").first()
is_valid = user.verify_password("password123")
print(is_valid) # True
```

### Node 2: Article Management System

**Function Description**: Implement functions such as article posting, editing, deletion, and paginated display, and support Markdown format and rich text content.

**Core Algorithms**:
- Article creation process
- Content format conversion
- Paginated query optimization
- Permission verification mechanism
- Article search function

**Input and Output Example**:
```python
from app.models import Post
from app.main.forms import PostForm
from app import db
from flask_login import current_user

# Create an article
form = PostForm()
form.body.data = "This is a test article"
post = Post(body=form.body.data, author=current_user._get_current_object())
db.session.add(post)
db.session.commit()
print(post.id) # 1

# Get the user's article list
posts = current_user.posts.order_by(Post.timestamp.desc()).all()
print(len(posts)) # 1
```

### Node 3: Comment System

**Function Description**: Implement the commenting function for articles, supporting operations such as comment posting, management, and review.

**Core Algorithms**:
- Comment creation process
- Comment review mechanism
- Paginated comment display
- Comment permission control
- Comment notification function

**Input and Output Example**:
```python
from app.models import Comment, Post
from app import db
from flask_login import current_user

# Add a comment
post = Post.query.get(1)
comment = Comment(body="This is a comment", author=current_user._get_current_object(), post=post)
db.session.add(comment)
db.session.commit()
print(comment.id) # 1

# Get the article's comments
comments = post.comments.order_by(Comment.timestamp.asc()).all()
print(len(comments)) # 1
```

### Node 4: Following System

**Function Description**: Implement the user following function, supporting operations such as following, unfollowing, and displaying the following list.

**Core Algorithms**:
- Establishment of following relationship
- Query of following list
- Follower statistics
- Following recommendation algorithm
- Following notification mechanism

**Input and Output Example**:
```python
from app.models import User
from app import db

# Follow a user
user1 = User.query.get(1)
user2 = User.query.get(2)
if not user1.is_following(user2):
    user1.follow(user2)
    db.session.commit()
print(user1.is_following(user2)) # True

# Get the following list
followed = user1.followed.all()
print(len(followed)) # 1
```

### Node 5: API Interface System

**Function Description**: Provide complete RESTful API services, supporting CRUD operations on users, articles, and comments.

**Core Algorithms**:
- API authentication mechanism
- Data serialization
- Unified error handling
- API version control
- Request rate limiting protection

**Input and Output Example**:
```python
from app import create_app
from app.models import User, Post
from app import db
import base64

# Using Flask test client to call API endpoints
app = create_app('testing')
with app.app_context():
    db.create_all()
    user = User(email='api@example.com', username='apiuser', confirmed=True)
    user.password = 'cat'
    db.session.add(user)
    db.session.commit()
    
    client = app.test_client()
    
    # Get user information via API (requires HTTP Basic Auth)
    credentials = base64.b64encode(b'api@example.com:cat').decode('utf-8')
    response = client.get(f'/api/v1/users/{user.id}',
                          headers={'Authorization': f'Basic {credentials}'})
    print(response.status_code) # 200
    
    # Create an article via API (requires HTTP Basic Auth)
    post_response = client.post('/api/v1/posts/',
                                json={'body': 'Article created by API'},
                                headers={'Authorization': f'Basic {credentials}'})
    print(post_response.status_code) # 201
```

### Node 6: Basic Application Testing

**Function Description**: Implement basic application function testing, including core testing functions such as application instance verification, configuration verification, and homepage access.

**Core Algorithms**:
- Application instance verification
- Configuration environment testing
- Homepage access testing
- Client function testing
- Basic function verification

**Input and Output Example**:
```python
from app import create_app
from flask import current_app

# Application instance testing
app = create_app('testing')
with app.app_context():
    assert current_app is not None
    assert current_app.config['TESTING'] == True

# Homepage access testing
client = app.test_client()
response = client.get('/')
assert response.status_code == 200
assert 'Stranger' in response.get_data(as_text=True)
```

### Node 7: Browser Automation Testing

**Function Description**: Use Selenium for browser automation testing to verify administrator functions and user interface interactions.

**Core Algorithms**:
- Browser automation
- Page element positioning
- User interaction simulation
- Administrator function verification
- Interface response testing

**Input and Output Example**:
```python
from selenium import webdriver
from app import create_app, db
from app.models import User, Role

# Browser automation testing
driver = webdriver.Chrome()
driver.get('http://localhost:5000/')

# User login testing
driver.find_element_by_link_text('Log In').click()
driver.find_element_by_name('email').send_keys('john@example.com')
driver.find_element_by_name('password').send_keys('cat')
driver.find_element_by_name('submit').click()

# Verify user login
assert 'Hello, john!' in driver.page_source
driver.quit()
```