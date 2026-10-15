const navToggle = document.querySelector(".nav-toggle");
const mainNav = document.querySelector(".main-nav");
const navLinks = document.querySelectorAll(".main-nav a");
const yearNode = document.querySelector("#year");
const projectModal = document.querySelector("#project-modal");
const modalContent = document.querySelector("#modal-content");
const modalClose = document.querySelector(".modal-close");
const form = document.querySelector("#contact-form");
const statusBox = document.querySelector("#form-status");
const resumeButton = document.querySelector("#resume-button");

const projectDetails = {
  pathbot: {
    title: 'PathBot',
    tag: 'Academic / Assistive Technology',
    description: 'PathBot is an academic assistive technology concept exploring indoor navigation support for home-based patients with mild dementia.',
    points: [
      'Button-operated destination selection',
      'Predefined indoor navigation routes',
      'Remote communication and monitoring concepts',
      'Accessible, single-story environment support'
    ]
  },
  cpp: {
    title: 'C++ Programming Projects',
    tag: 'Programming / Software Development',
    description: 'This project area represents a collection of C++ practice programs used to strengthen logic, problem-solving, and core programming fundamentals.',
    points: [
      'Programming logic exercises',
      'Problem-solving practice',
      'Software fundamentals and iteration',
      'Ongoing skill-building through project work'
    ]
  },
  debut: {
    title: 'Online Debut Invitation',
    tag: 'Creative Web Development',
    description: 'A mobile-friendly digital invitation concept designed to present event details clearly and elegantly while adding interactive elements for the celebration experience.',
    points: [
      'Event details and guest accessibility',
      'Responsive invitation layout',
      'Interactive invitation experience',
      'Creative presentation for a special occasion'
    ]
  },
  wedding: {
    title: 'Online Wedding Invitation',
    tag: 'Creative Web Development',
    description: 'A romantic invitation concept built to present celebration details in a polished, accessible, and interactive digital format.',
    points: [
      'Elegant event presentation',
      'Responsive mobile layout',
      'Venue and celebration details',
      'Accessible digital invitation design'
    ]
  }
};

if (yearNode) {
  yearNode.textContent = new Date().getFullYear();
}

if (resumeButton) {
  resumeButton.addEventListener('click', function (event) {
    event.preventDefault();
    resumeButton.setAttribute('aria-disabled', 'true');
    resumeButton.disabled = true;
    resumeButton.textContent = 'Resume Coming Soon';
  });
}

if (navToggle && mainNav) {
  navToggle.addEventListener('click', function () {
    var isOpen = mainNav.classList.toggle('is-open');
    navToggle.setAttribute('aria-expanded', String(isOpen));
  });

  navLinks.forEach(function (link) {
    link.addEventListener('click', function () {
      mainNav.classList.remove('is-open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });
}

if (typeof IntersectionObserver !== 'undefined') {
  var sectionObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) {
        return;
      }

      var id = entry.target.getAttribute('id');
      navLinks.forEach(function (link) {
        var isActive = link.getAttribute('href') === '#' + id;
        link.classList.toggle('active', isActive);
      });
    });
  }, { threshold: 0.45 });

  document.querySelectorAll('.section').forEach(function (section) {
    sectionObserver.observe(section);
  });
}

var openModal = function (slug) {
  var detail = projectDetails[slug];
  if (!detail) {
    return;
  }

  var listMarkup = detail.points.map(function (point) {
    return '<li>' + point + '</li>';
  }).join('');

  modalContent.innerHTML = '<span class="modal-tag">' + detail.tag + '</span>' +
    '<h3>' + detail.title + '</h3>' +
    '<p class="modal-subtext">' + detail.description + '</p>' +
    '<ul>' + listMarkup + '</ul>';

  projectModal.classList.add('is-open');
  projectModal.setAttribute('aria-hidden', 'false');

  var firstFocusable = projectModal.querySelector('button');
  if (firstFocusable) {
    firstFocusable.focus();
  }
};

var closeModal = function () {
  projectModal.classList.remove('is-open');
  projectModal.setAttribute('aria-hidden', 'true');
};

document.querySelectorAll('.project-detail').forEach(function (button) {
  button.addEventListener('click', function () {
    openModal(button.dataset.project);
  });
});

if (modalClose) {
  modalClose.addEventListener('click', closeModal);
}

if (projectModal) {
  projectModal.addEventListener('click', function (event) {
    if (event.target === projectModal) {
      closeModal();
    }
  });
}

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && projectModal && projectModal.classList.contains('is-open')) {
    closeModal();
  }
});

var validateField = function (field, errorField, label) {
  var value = field.value.trim();

  if (!value) {
    errorField.textContent = label + ' is required.';
    field.setAttribute('aria-invalid', 'true');
    return false;
  }

  if (field.type === 'email') {
    var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(value)) {
      errorField.textContent = 'Please enter a valid email address.';
      field.setAttribute('aria-invalid', 'true');
      return false;
    }
  }

  errorField.textContent = '';
  field.setAttribute('aria-invalid', 'false');
  return true;
};

if (form) {
  var fullName = document.querySelector('#full-name');
  var email = document.querySelector('#email');
  var subject = document.querySelector('#subject');
  var message = document.querySelector('#message');

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    var isNameValid = validateField(fullName, document.querySelector('#full-name-error'), 'Full Name');
    var isEmailValid = validateField(email, document.querySelector('#email-error'), 'Email Address');
    var isSubjectValid = validateField(subject, document.querySelector('#subject-error'), 'Subject');
    var isMessageValid = validateField(message, document.querySelector('#message-error'), 'Message');

    if (!isNameValid || !isEmailValid || !isSubjectValid || !isMessageValid) {
      statusBox.textContent = 'Please fix the highlighted fields and try again.';
      statusBox.style.color = '#ff6b7a';
      return;
    }

    var submitButton = form.querySelector('.submit-button');
    submitButton.disabled = true;
    submitButton.textContent = 'Sending...';

    setTimeout(function () {
      statusBox.textContent = 'Demo form only: connect an email service or update your contact details to receive messages. For now, use [YOUR EMAIL ADDRESS].';
      statusBox.style.color = '#67f0d2';
      submitButton.disabled = false;
      submitButton.textContent = 'Send Message';
      form.reset();
    }, 800);
  });
}
