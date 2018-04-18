/* eslint no-await-in-loop: off */
// Linter configuration, cannot avoit await in loop due to API rate limits
const config = require('./config.js');
const constants = require('./const.js');

const mustache = require('mustache');
const fs = require('fs');
const nodemailer = require('nodemailer');
const expa = require('node-gis-wrapper')(config.devUser, config.devPass);

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at:', p, 'reason:', reason);
});

const EY = {
  MEXICO: 1589,
};

const CURR_PROD = process.env.PROD || 'GV';

/* const MAIL_TEMPLATE = Object.freeze({
  GV: '/home/serch/MCVPDI1718/vp_notifications/template.mst',
  GT: '/home/serch/MCVPDI1718/vp_notifications/template_gt.mst',
  GE: '/home/serch/MCVPDI1718/vp_notifications/template_ge.mst',
}); */

const MAIL_TEMPLATE = Object.freeze({
  GV: '/Users/sgarcias/Developer/vp_notifications/template.mst',
  GT: '/Users/sgarcias/Developer/vp_notifications/template_gt.mst',
  GE: '/Users/sgarcias/Developer/vp_notifications/template_ge.mst',
});

// These are to be used in production, for testing use fakeEmail variable
const USER = constants.gmail.user;
const PASS = constants.gmail.pass;

// EXPA Setup Constants (affects the execution of the script overall)
const START_DATE = getStartDate(); // Start Date is today minus thirty days
const PER_PAGE = 50;
const PARALLEL = 3;
const applicationsUrl = 'applications.json';

// Ordered list of LCs (alphabetical name)
const LCs = constants.lcs.map(el => ({ id: el.id, name: el.name })).sort((a, b) => a.name.toString().localeCompare(b.name, 'la'));

const PRODUCT = Object.freeze({
  iGT: { name: 'iGT', type: 'opportunity', programme: 2 },
  oGT: { name: 'oGT', type: 'person', programme: 2 },
  iGV: { name: 'iGV', type: 'opportunity', programme: 1 },
  oGV: { name: 'oGV', type: 'person', programme: 1 },
  iGE: { name: 'iGE', type: 'opportunity', programme: 5 },
  oGE: { name: 'oGE', type: 'person', programme: 5 },
});

try {
  main();
} catch (err) {
  console.log('Main catch');
  console.error(err);
}

async function main() {
  // Get all OGX applications from the start date until today
  console.log(`Retrieving all ${CURR_PROD} applications since ${START_DATE}...`);
  const applications = await getProductApplications(CURR_PROD, START_DATE, EY.MEXICO);
  console.log(`There are ${applications.length} applications retrieved`);

  // let fakeEmail; // To be used if fakeEmail is not used
  const fakeEmail = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false, // true for 465, false for other ports
    auth: {
      user: constants.ethereal.user, // generated ethereal user
      pass: constants.ethereal.pass, // generated ethereal password
    },
  });
  // Create Reusable Transporter object using the default SMTP transport
  const email = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
      user: USER,
      pass: PASS,
    },
  });

  LCs.forEach(async (lc) => {
    try { // Do synchronous email sending instead of asynchronous
      const lcApps = applications.filter(app => app.person.home_lc.id === lc.id);

      const open = filterAndFormatApplicationByStatus(lcApps, 'open');
      const accepted = filterAndFormatApplicationByStatus(lcApps, 'matched');
      const inProgress = filterAndFormatApplicationByStatus(lcApps, 'accepted');
      const approved = filterAndFormatApplicationByStatus(lcApps, 'approved');

      const body = mustacheRender(open, accepted, inProgress, approved, lc.name);

      // Check if there is an email address to send
      const lcEmails = constants.emails.find(el => el.id === lc.id);
      if (lcEmails && lcEmails[`to${CURR_PROD}`]) {
        const mailOptions = getEmailOptions(CURR_PROD, lc, body);
        if (fakeEmail) {
          const info = await sendEmail(fakeEmail, mailOptions);
          console.log(`Sent fake email to ${lc.name}`);
          console.log(nodemailer.getTestMessageUrl(info));
        } else if (email) {
          await sendEmail(email, mailOptions);
          console.log(`Sent email to ${lc.name}`);
        }
      } else {
        console.log(`Skipping email for ${lc.name}, no to${CURR_PROD} field.`);
      }
    } catch (err) {
      console.log(`There was an error while sending message to LC ${lc.name}`);
    }
  });
}


function getEmailOptions(prod, lc, body) { // Note to self: Global Vars are evil :C
  const mailOptions = {
    from: constants.FROM_DATA,
    to: constants.emails.find(el => el.id === lc.id)[`to${prod}`].toString(), // list of receivers
    cc: constants.CC_EMAIL[`to${prod}`],
    subject: `o${prod} Applications Update - ${lc.name}`, // Subject line
    html: body, // html body
  };
  return mailOptions;
}

async function getProductApplications(prod, startDate, ey) {
  switch (prod) {
    case 'GT':
      return getOGTApplications(startDate, ey);
    case 'GE':
      return getOGEApplications(startDate, ey);
    default: // GV is default product
      return getOGVApplications(startDate, ey);
  }
}

function prepareArrays(open, accepted, inProgress, approved) {
  const openNew = open.reduce((a, el) => {
    let res;

    const found = a.find(acc => acc.person.id === el.person.id);
    if (found === undefined) {
      res = {
        count: 1,
        person: {
          id: el.person.id,
          url: el.person.url,
          full_name: el.person.full_name,
          email: el.person.email,
          home_lc: el.person.home_lc,
        },
      };
      a.push(res);
    } else { found.count += 1; }
    return a;
  }, Array.from([]));

  const acceptedNew = accepted;
  const inProgressNew = inProgress.map((el) => {
    const e = el;
    e.hasLDM = e.permissions.has_completed_ldm;
    e.hasPayed = e.permissions.has_paid_for_match;
    return e;
  });


  return {
    openNew,
    acceptedNew,
    inProgressNew,
    approvedNew: approved,
  };
}

function mustacheRender(open, accepted, inProgress, approved, lc) {
  const template = fs.readFileSync(MAIL_TEMPLATE[CURR_PROD]).toString('utf8');

  const res = prepareArrays(open, accepted, inProgress, approved);

  const data = {
    lc,
    openNo: res.openNew.length,
    acceptedNo: res.acceptedNew.length,
    inProgressNo: res.inProgressNew.length,
    approvedNo: res.approvedNew.length,
    open: res.openNew,
    accepted: res.acceptedNew,
    inProgress: res.inProgressNew,
    approved: res.approvedNew,
  };

  const rendered = mustache.render(template, data);

  return rendered;
}

function sendEmail(email, mailOptions) {
  const p = new Promise(resolve => email.sendMail(mailOptions, (error, info) => {
    if (error) throw error;
    resolve(info);
  }));

  p.catch((err) => {
    console.log(err);
    throw err;
  });
  return p;
}

function filterAndFormatApplicationByStatus(apps, status) {
  const PEOPLE_URL = 'https://experience.aiesec.org/#/people/';
  const OPPORTUNITY_URL = 'https://experience.aiesec.org/#/opportunity/';

  return apps.filter(el => el.status === status).map(el => ({
    id: el.id,
    person: {
      id: el.person.id,
      email: el.person.email,
      url: `${PEOPLE_URL + el.person.id}/applications`,
      full_name: el.person.full_name,
      ldm_to_complete: el.person.ldm_to_complete,
      home_lc: el.person.home_lc,
    },
    an_signed_at: el.an_signed_at,
    opportunity: {
      id: el.opportunity.id,
      url: OPPORTUNITY_URL + el.opportunity.id,
      office: {
        id: el.opportunity.office.id,
        name: el.opportunity.office.name,
        country: el.opportunity.office.country,
      },
    },
    permissions: el.permissions,
    updated_at: el.updated_at,
  }));
}

async function getOGTApplications(start, lc) {
  console.log('Called Get OGT Applications');
  try {
    const params = {
      'filters[created_at][from]': start,
      'filters[person_committee]': lc,
      'filters[programmes][]': PRODUCT.oGT.programme,
    };

    return await getApplicationsFromEXPA(params);
  } catch (err) {
    console.error(err);
    throw Error('getOGTApplications Failed!');
  }
}

async function getOGEApplications(start, lc) {
  console.log('Called Get OGE Applications');
  try {
    const params = {
      'filters[created_at][from]': start,
      'filters[person_committee]': lc,
      'filters[programmes][]': PRODUCT.oGE.programme,
    };

    return await getApplicationsFromEXPA(params);
  } catch (err) {
    console.error(err);
    throw Error('getOGEApplications Failed!');
  }
}

async function getOGVApplications(start, lc) {
  try {
    const params = {
      'filters[created_at][from]': start,
      'filters[person_committee]': lc,
      'filters[programmes][]': PRODUCT.oGV.programme,
    };

    return await getApplicationsFromEXPA(params);
  } catch (err) {
    console.error(err);
    throw Error('getOGVApplications Failed!');
  }
}

async function getApplicationsFromEXPA(params) {
  const promises = [];
  let retrieved = 0;
  let data = [];

  console.log('Getting number of total items from EXPA...');
  console.time('Timer');
  let sentParams = Object.assign({ page: 1, per_page: 1 }, params);
  const res = await getWithPaging(applicationsUrl, sentParams);
  const items = res.paging.total_items;
  const totalPages = Math.ceil(items / PER_PAGE);

  sentParams = Object.assign({ page: 1, per_page: PER_PAGE }, params);
  console.log(`Done! Total items: ${items}`);
  console.log(`Per page: ${PER_PAGE}, Total Pages: ${totalPages}`);
  console.timeEnd('Timer');

  do {
    let i = 0;

    console.log('Bulk retrieving pages...');
    while (i < PARALLEL && totalPages >= sentParams.page) {
      console.log(sentParams.page);

      promises.push(getWithPaging(applicationsUrl, Object.assign({}, sentParams)));
      sentParams.page += 1;
      i += 1;
    }

    console.log('Waiting for pages...');
    data = await Promise.all(promises);
    console.log('Done!');

    // console.log(promises); //Prints promises
    retrieved += PER_PAGE * PARALLEL;
  } while (retrieved < items);


  return data.map(el => el.data).reduce((a, c) => a.concat(c));
}


function getStartDate() {
  return '2018-02-01';
}

async function getWithPaging(url, data, tried) {
  let tries;
  if (!tried) {
    tries = 1;
  } else {
    tries = tried;
  }

  return req(expa.get, url, data).then((res) => {
    if (!res.paging) throw res;
    console.log(`Retrieved page: ${res.paging.current_page}`);
    return res;
  }).catch((err) => {
    console.log(`Retrieving info failed for page ${data.page}, retrying... ${err ? JSON.stringify(err) : ''}`);
    if (tries <= 3) {
      tries += 1;
      return getWithPaging(url, data, tries);
    }
    throw Error(`Too many tries while retrieving page ${data.page} in EXPA`);
  });
}
// Function definition. Interactions with node-gis-wrapper functions to use ES6 Promises
/* async function post(url, data) { return req(expa.post, url, data); }
async function patch(url, data) { return req(expa.patch, url, data); } */
async function req(fn, url, data) {
  return fn(url, data).then(msg => Promise.resolve(msg)).catch(err => Promise.reject(err));
}
